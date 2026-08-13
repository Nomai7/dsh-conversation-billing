window.__ModuleLoader__.load({
	id: "dsh-conversation-billing",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		//#region rates
		/**
		 * Official DeepSeek peak/off-peak pricing (effective 2026-08-17): ¥ per 1M tokens.
		 * Peak hours are Beijing time (UTC+8) 9:00-12:00 and 14:00-18:00; the rest is off-peak.
		 */
		const RATES = {
			"deepseek-v4-flash": {
				peak: { hit: 0.1, miss: 3.0, output: 9.0 },
				offpeak: { hit: 0.05, miss: 1.5, output: 4.5 }
			},
			"deepseek-v4-pro": {
				peak: { hit: 0.3, miss: 9.0, output: 27.0 },
				offpeak: { hit: 0.15, miss: 4.5, output: 13.5 }
			}
		};
		/** Unknown models fall back to the flash peak rate (conservative). */
		const DEFAULT_RATES = { hit: 0.1, miss: 3.0, output: 9.0 };
		/** Beijing-time (UTC+8) peak check: 9-12, 14-18 (boundaries inclusive). */
		function isPeakBeijing(ms) {
			const d = new Date(ms);
			const hour = (d.getUTCHours() + 8) % 24;
			return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
		}
		function rateFor(model, ms) {
			const entry = RATES[model];
			if (entry === undefined) return DEFAULT_RATES;
			return isPeakBeijing(ms) ? entry.peak : entry.offpeak;
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
		async function loadAllEvents(connection, sessionId) {
			const entries = [];
			let beforeSeq;
			for (;;) {
				const { result } = await connection.api.sessions.history({
					sessionId,
					beforeSeq,
					maxMessages: 200
				});
				if (!result.ok) throw new Error(result.error && result.error.message ? result.error.message : "session.history failed");
				const pageEvents = result.value.events.map((entry) => entry.event);
				entries.unshift(...pageEvents);
				if (!result.value.hasMore || pageEvents.length === 0) break;
				beforeSeq = pageEvents[0].seq;
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
			for (const { model, usage, time } of stepUsage.values()) {
				const m = model === null || model === undefined ? "unknown" : model;
				const rate = rateFor(m, typeof time === "number" ? time : Date.now());
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
			if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return "¥0.00";
			if (n >= 1) return "¥" + n.toFixed(2);
			return "¥" + n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
		}
		//#endregion

		//#region component
		/**
		 * The tool-row badge (just left of the send button): reads the
		 * session's token usage and event log, prices it with the built-in
		 * rate table, and renders the running total.
		 */
		function BillingDock({ fetchEstimate, sessionId, useProjection }) {
			const usage = useProjection === undefined ? undefined : useProjection("tokenUsage");
			const usageKey = usage === undefined
				? "none"
				: [usage.uncachedInputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens].join(":");
			const [data, setData] = react.useState(null);
			const [failed, setFailed] = react.useState(false);
			const [errorText, setErrorText] = react.useState("");

			react.useEffect(() => {
				if (typeof sessionId !== "string" || sessionId === "" || fetchEstimate === undefined) return;
				let alive = true;
				setFailed(false);
				setErrorText("");
				fetchEstimate(sessionId).then((res) => {
					if (!alive) return;
					if (res !== null && res !== undefined) setData(res);
					else setFailed(true);
				}).catch((err) => {
					if (alive) {
						setFailed(true);
						setErrorText(err && err.message ? err.message : String(err));
					}
				});
				return () => { alive = false };
			}, [sessionId, usageKey, fetchEstimate]);

			if (failed) return react.createElement("span", {
				className: "dsh-billing-cell",
				title: errorText || undefined
			}, "费用不可用");
			if (data === null) return null;
			const t = data.total;
			if (t === undefined || (t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens) === 0) {
				return react.createElement("span", { className: "dsh-billing-cell", title: "尚无对话用量" }, "¥0.00");
			}
			const per = (data.perModel || []).map((m) => `${m.model}: ¥${m.cost !== undefined ? m.cost.toFixed(4) : "?"}（输入 ${fmtTokens(m.inputTokens + m.cacheReadTokens + m.cacheWriteTokens)} · 输出 ${fmtTokens(m.outputTokens)}）`).join("\n");
			return react.createElement("span", {
				className: "dsh-billing-cell",
				title: per || undefined
			}, react.createElement("span", { className: "dsh-billing-glyph" }, "¥"), fmtYuan(t.cost));
		}
		//#endregion

		//#region plugin
		/** Required client services. */
		const inject = ["slots", "connection"];
		/**
		 * Client plugin body: register the billing badge in the tool row,
		 * just left of the primary send button.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			const slots = ctx.get("slots");
			if (slots === undefined) return;
			const connection = ctx.get("connection");
			const fetchEstimate = connection === undefined
				? undefined
				: async (sessionId) => estimateFromEvents(await loadAllEvents(connection, sessionId));
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
