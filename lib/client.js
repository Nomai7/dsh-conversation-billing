window.__ModuleLoader__.load({
	id: "dsh-conversation-billing",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		//#region rates
		/**
		 * Current pricing (before the 2026-08-17 increase): ¥ per 1M tokens.
		 * Flat rates; the peak/off-peak table replaces this after the increase.
		 */
		const RATES = {
			"deepseek-v4-flash": { hit: 0.02, miss: 1.0, output: 2.0 },
			"deepseek-v4-pro": { hit: 0.025, miss: 3.0, output: 6.0 }
		};
		/** Unknown models fall back to the flash rate (conservative). */
		const DEFAULT_RATES = { hit: 0.02, miss: 1.0, output: 2.0 };
		function rateFor(model) {
			const entry = RATES[model];
			return entry === undefined ? DEFAULT_RATES : entry;
		}
		function costOf(rate, tokens) {
			return typeof tokens === "number" && tokens > 0 ? (tokens / 1e6) * rate : 0;
		}
		//#endregion

		//#region estimation
		/**
		 * Fetch the whole session event log via session.history, paging backwards
		 * from the newest event until `hasMore` is false, then fold usage per
		 * (turn, step) with the model and event time of that request.
		 */
		async function loadAllEvents(connection, sessionId, subagentAddress) {
			const chunks = [];
			let beforeSeq;
			// Guard against pathological sessions: cap total pages and events.
			const MAX_PAGES = 200;
			const MAX_EVENTS = 2e6;
			let pages = 0;
			for (;;) {
				const payload = subagentAddress === undefined
					? { sessionId, beforeSeq, maxMessages: 200 }
					: { ...subagentAddress, beforeSeq, maxMessages: 200 };
				const { result } = subagentAddress === undefined
					? await connection.api.sessions.history(payload)
					: await connection.api.subagents.history(payload);
				if (!result.ok) throw new Error(result.error && result.error.message ? result.error.message : "history failed");
				const pageEvents = result.value.events.map((entry) => entry.event);
				// Never spread into a push call: a long session's page can carry
				// tens of thousands of chunk events and `push(...pageEvents)` would
				// blow the argument-count limit ("Maximum call stack size exceeded").
				chunks.push(pageEvents);
				pages += 1;
				if (!result.value.hasMore || pageEvents.length === 0 || pages >= MAX_PAGES) break;
				beforeSeq = pageEvents[0].seq;
			}
			const entries = [];
			for (let c = chunks.length - 1; c >= 0; c--) {
				for (let i = 0; i < chunks[c].length; i++) {
					entries.push(chunks[c][i]);
					if (entries.length >= MAX_EVENTS) return entries;
				}
			}
			return entries;
		}
		/** Fold one raw event log into per-model usage buckets + total cost. */
		function estimateFromEvents(events) {
			const stepUsage = new Map();
			let currentModel = null;
			for (const ev of events) {
				if (ev.type === "request/header") {
					const cfg = ev.data && ev.data.header && ev.data.header.config;
					if (cfg && typeof cfg.model === "string" && cfg.model !== "") currentModel = cfg.model;
				} else if (ev.type === "assistant/message") {
					const usage = ev.data && ev.data.usage;
					if (usage) stepUsage.set(ev.data.turn + ":" + ev.data.step, { model: currentModel, usage, time: ev.time });
				} else if (ev.type === "assistant/chunk") {
					const chunk = ev.data && ev.data.chunk;
					if (chunk && chunk.type === "usage" && chunk.usage) {
						stepUsage.set(ev.data.turn + ":" + ev.data.step, { model: currentModel, usage: chunk.usage, time: ev.time });
					}
				}
			}
			const perModel = new Map();
			for (const { model, usage } of stepUsage.values()) {
				const m = model === null || model === undefined ? "unknown" : model;
				const rate = rateFor(m);
				const cost = costOf(rate.miss, usage.inputTokens) + costOf(rate.hit, usage.cacheReadTokens) + costOf(rate.miss, usage.cacheWriteTokens) + costOf(rate.output, usage.outputTokens);
				let row = perModel.get(m);
				if (row === undefined) {
					row = { model: m, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 };
					perModel.set(m, row);
				}
				row.inputTokens += typeof usage.inputTokens === "number" ? usage.inputTokens : 0;
				row.outputTokens += typeof usage.outputTokens === "number" ? usage.outputTokens : 0;
				row.cacheReadTokens += typeof usage.cacheReadTokens === "number" ? usage.cacheReadTokens : 0;
				row.cacheWriteTokens += typeof usage.cacheWriteTokens === "number" ? usage.cacheWriteTokens : 0;
				row.cost += cost;
			}
			const list = [];
			let totalCost = 0;
			let totalInput = 0;
			let totalOutput = 0;
			let totalCacheRead = 0;
			let totalCacheWrite = 0;
			for (const row of perModel.values()) {
				totalCost += row.cost;
				totalInput += row.inputTokens;
				totalOutput += row.outputTokens;
				totalCacheRead += row.cacheReadTokens;
				totalCacheWrite += row.cacheWriteTokens;
				list.push(row);
			}
			list.sort((a, b) => b.cost - a.cost);
			return {
				total: { cost: totalCost, inputTokens: totalInput, outputTokens: totalOutput, cacheReadTokens: totalCacheRead, cacheWriteTokens: totalCacheWrite },
				perModel: list
			};
		}
		//#endregion

		//#region formatting
		function fmtTokens(n) {
			if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
			if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
			return String(n);
		}
		function fmtYuan(n) {
			if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return "0.00";
			return n.toFixed(2);
		}
		//#endregion

		//#region component
		/**
		 * The tool-row badge (just left of the send button): reads the
		 * session's token usage and event log, prices it with the built-in
		 * rate table, and renders the running total.
		 */
		function BillingDock({ fetchEstimate, sessionId, useProjection }) {
			const [data, setData] = react.useState(null);
			const [failed, setFailed] = react.useState(false);
			const [errorText, setErrorText] = react.useState("");
			const [lastKey, setLastKey] = react.useState("");

			react.useEffect(() => {
				if (typeof sessionId !== "string" || sessionId === "" || fetchEstimate === undefined) return;
				if (lastKey === sessionId) return;
				let alive = true;
				setFailed(false);
				setErrorText("");
				fetchEstimate(sessionId).then((res) => {
					if (!alive) return;
					setLastKey(sessionId);
					if (res !== null && res !== undefined) setData(res);
					else setFailed(true);
				}).catch((err) => {
					if (alive) {
						setFailed(true);
						const msg = err && err.message ? err.message : String(err);
						setErrorText(msg);
						try {
							console.error("[dsh-conversation-billing] estimate failed:", err);
						} catch (e) { /* noop */ }
					}
				});
				return () => { alive = false };
			}, [sessionId, fetchEstimate, lastKey]);

			if (failed) return react.createElement("span", {
				className: "dsh-billing-cell",
				title: errorText || undefined
			}, errorText !== "" && errorText !== undefined ? `费用不可用:${String(errorText).slice(0, 40)}` : "费用不可用");
			if (data === null) return null;
			const t = data.total;
			if (t === undefined || (t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens) === 0) {
				return react.createElement("span", { className: "dsh-billing-cell", title: "尚无对话用量" },
					react.createElement("span", { className: "dsh-billing-glyph" }, "¥"), "0.00");
			}
			const per = (data.perModel || []).map((m) => `${m.model}: ¥${m.cost !== undefined ? m.cost.toFixed(2) : "?"}（输入 ${fmtTokens(m.inputTokens + m.cacheReadTokens + m.cacheWriteTokens)} · 输出 ${fmtTokens(m.outputTokens)}）`).join("\n");
			return react.createElement("span", {
				className: "dsh-billing-cell",
				title: per || undefined
			}, react.createElement("span", { className: "dsh-billing-glyph" }, "¥"), fmtYuan(t.cost));
		}
		//#endregion

		//#region plugin
		/** Required client services. */
		const inject = ["slots", "connection", "sessions"];
		/**
		 * Client plugin body: register the billing badge in the tool row,
		 * just left of the primary send button.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			const slots = ctx.get("slots");
			if (slots === undefined) return;
			const connection = ctx.get("connection");
			const sessions = ctx.get("sessions");
			const fetchEstimate = connection === undefined
				? undefined
				: async (sessionId) => {
					const subagentAddress = sessions === undefined || typeof sessions.subagentAddress !== "function"
						? undefined
						: sessions.subagentAddress(sessionId);
					return estimateFromEvents(await loadAllEvents(connection, sessionId, subagentAddress));
				};
			slots.inject("conversation.input.right", () => slots.register({
				name: "conversation.input.right",
				id: "billing",
				order: 0,
				inject: () => ({ fetchEstimate })
			}, BillingDock));
		}
		//#endregion

		//#region styles
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"dsh-conversation-billing\"]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-conversation-billing";
			tag.dataset.pluginCss = "dsh-conversation-billing";
			tag.textContent = ".dsh-billing-cell{display:inline-flex;align-items:center;gap:2px;height:28px;padding:0 10px;border-radius:14px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1;white-space:nowrap;cursor:default;user-select:none}.dsh-billing-glyph{font-size:10px;opacity:.6}";
			document.head.appendChild(tag);
		}
		//#endregion

		exports.BillingDock = BillingDock;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
