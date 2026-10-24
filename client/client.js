window.__ModuleLoader__.load({
	id: "dsh-model-fallback",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");

		/** Host entry id == settings namespace. */
		const NS = "model-fallback";
		const LOCALE_NS = "settings.modelFallback";
		/** 一个下拉里同时表达 provider 和 model。 */
		const SEP = "\u0000";

		const zh = {
			nav: "模型兜底",
			title: "备用模型",
			hint: "主模型没有回应时（超时、断线、5xx、空响应），按下面的顺序从上到下依次换模型，并在同一步重试。",
			slot: "备用模型",
			choose: "选择模型",
			add: "再加一个",
			remove: "移除",
			save: "保存",
			saving: "保存中…",
			reset: "恢复默认",
			saved: "已保存，下一条消息就按新配置走。",
			failed: "保存失败，配置没有改。",
			readOnly: "本部署的设置为只读。",
			loadingSettings: "正在读取设置…",
			emptyField: "每一行都要选一个模型。",
			immediate: "保存即生效，不用重启。",
			loading: "正在读取模型列表…",
			retry: "重试",
			catalogError: "模型列表读取失败",
			manual: "（可以先手填）",
			counts: "个 provider",
			models: "个模型",
			providerPlaceholder: "例如 workbuddy-ai",
			modelPlaceholder: "例如 deepseek-v4.1-flash",
			missing: "（已保存，不在列表）",
		};
		const en = {
			nav: "Model fallback",
			title: "Backup models",
			hint: "When the primary model stops responding (timeout, transport, 5xx, empty response), try these backups from top to bottom and retry the same step.",
			slot: "Backup model",
			choose: "Choose a model",
			add: "Add another",
			remove: "Remove",
			save: "Save",
			saving: "Saving…",
			reset: "Reset to default",
			saved: "Saved. The next message uses the new chain.",
			failed: "Save failed; nothing changed.",
			readOnly: "This deployment stores settings read-only.",
			loadingSettings: "Reading settings…",
			emptyField: "Every row needs a model.",
			immediate: "Takes effect on save; no restart needed.",
			loading: "Reading the model list…",
			retry: "Retry",
			catalogError: "Could not read the model list",
			manual: "(you can type it in)",
			counts: "providers",
			models: "models",
			providerPlaceholder: "e.g. workbuddy-ai",
			modelPlaceholder: "e.g. deepseek-v4.1-flash",
			missing: " (saved, not in list)",
		};

		const box = {
			display: "flex",
			flexDirection: "column",
			gap: 16,
			color: "var(--dsw-alias-label-primary)",
			fontSize: 13,
			lineHeight: "20px",
		};
		const field = {
			flex: 1,
			minWidth: 0,
			height: 32,
			padding: "0 10px",
			borderRadius: 8,
			border: ".5px solid var(--dsw-alias-border-l3)",
			background: "transparent",
			color: "var(--dsw-alias-label-primary)",
			fontSize: 13,
		};
		const button = (primary) => ({
			height: 30,
			padding: "0 12px",
			borderRadius: 8,
			border: primary ? "none" : ".5px solid var(--dsw-alias-border-l3)",
			background: primary ? "var(--dsw-alias-state-business-primary)" : "transparent",
			color: primary ? "#fff" : "var(--dsw-alias-label-primary)",
			fontSize: 13,
			cursor: "pointer",
		});
		const subtle = {
			margin: 0,
			color: "var(--dsw-alias-label-tertiary)",
			fontSize: 12,
		};

		function toRows(fallbacks) {
			return Array.isArray(fallbacks)
				? fallbacks.map((f) => ({ provider: String(f?.provider ?? ""), model: String(f?.model ?? "") }))
				: [];
		}

		function emptyRow() {
			return { provider: "", model: "" };
		}

		function keyOf(row) {
			return row.provider === "" || row.model === "" ? "" : `${row.provider}${SEP}${row.model}`;
		}

		/** Subscribe to the config form, with a fallback for React builds without useSyncExternalStore. */
		function useSnapshot(form) {
			if (typeof React.useSyncExternalStore === "function") {
				return React.useSyncExternalStore(
					(listener) => form.subscribe(listener),
					() => form.getSnapshot(),
				);
			}
			const [snap, setSnap] = React.useState(() => form.getSnapshot());
			React.useEffect(() => form.subscribe(() => setSnap(form.getSnapshot())), []);
			return snap;
		}

		/**
		 * Load the Host model catalog. 刚开机时模型目录可能还没上报完，空结果和
		 * 网络错误都按“暂时失败”处理，自动退避重试几次，实在不行再报错并允许手填。
		 */
		function useCatalog(props) {
			const preset = props.catalog;
			const [state, setState] = React.useState(preset === undefined
				? { status: "loading", groups: [], error: null }
				: { status: "ready", groups: preset, error: null });
			const [token, setToken] = React.useState(0);

			React.useEffect(() => {
				if (preset !== undefined || typeof props.loadCatalog !== "function") return undefined;
				let alive = true;
				let timer = null;
				let attempt = 0;
				const run = () => {
					setState((old) => ({ ...old, status: "loading", error: null }));
					props.loadCatalog().then((groups) => {
						if (!alive) return;
						if (!Array.isArray(groups) || groups.length === 0) {
							throw new Error("empty catalog");
						}
						setState({ status: "ready", groups, error: null });
					}).catch((error) => {
						if (!alive) return;
						attempt += 1;
						const message = error instanceof Error ? error.message : String(error);
						if (attempt < 6) {
							setState({ status: "loading", groups: [], error: message });
							timer = setTimeout(run, attempt * 1200);
						} else {
							setState({ status: "error", groups: [], error: message });
						}
					});
				};
				run();
				return () => {
					alive = false;
					if (timer !== null) clearTimeout(timer);
				};
			}, [token, preset]);

			const reload = () => setToken((value) => value + 1);
			return { ...state, reload };
		}

		function SettingsPanel(props) {
			const { t, form } = props;
			const snap = useSnapshot(form);
			const catalog = useCatalog(props);
			const saved = toRows(snap?.value?.fallbacks);
			// 空链时先摆两个空位：至少能直接填两个备用模型。
			const initial = saved.length > 0 ? saved : [emptyRow(), emptyRow()];
			const [draft, setDraft] = React.useState(null);
			const [busy, setBusy] = React.useState(false);
			const [notice, setNotice] = React.useState(null);
			const rows = draft ?? initial;
			const writable = snap?.writable === true;
			const groups = catalog.groups;
			const options = [];
			for (const group of groups) {
				const models = Array.isArray(group.models) ? group.models : [];
				if (models.length === 0) continue;
				options.push({
					group: group.id,
					label: group.name ?? group.id,
					models: models.map((model) => ({
						value: `${group.id}${SEP}${model.id}`,
						label: model.name ?? model.id,
					})),
				});
			}
			const modelCount = options.reduce((total, group) => total + group.models.length, 0);
			const known = new Set(options.flatMap((group) => group.models.map((model) => model.value)));
			const useSelect = catalog.status === "ready";

			const edit = (index, patch) => {
				setNotice(null);
				setDraft(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
			};
			const add = () => {
				setNotice(null);
				setDraft([...rows, emptyRow()]);
			};
			const remove = (index) => {
				setNotice(null);
				setDraft(rows.filter((_, i) => i !== index));
			};

			const commit = async (ops) => {
				setBusy(true);
				let ok = false;
				try {
					ok = await form.mutate(ops, snap.revision);
				} catch {
					ok = false;
				}
				setBusy(false);
				if (ok) {
					setDraft(null);
					setNotice("saved");
				} else {
					setNotice("failed");
				}
			};

			const save = () => {
				const value = rows
					.map((row) => ({ provider: row.provider.trim(), model: row.model.trim() }))
					.filter((row) => row.provider !== "" || row.model !== "");
				if (value.some((row) => row.provider === "" || row.model === "")) {
					setNotice("emptyField");
					return;
				}
				commit([{ op: "set", path: ["fallbacks"], value }]);
			};

			const reset = () => {
				setDraft(null);
				commit([{ op: "unset", path: ["fallbacks"] }]);
			};

			const noticeText = notice === null ? null : {
				saved: t("saved"),
				failed: t("failed"),
				emptyField: t("emptyField"),
			}[notice];
			const noticeColor = notice === "saved"
				? "var(--dsw-alias-state-success-primary, var(--dsw-alias-label-secondary))"
				: "var(--dsw-alias-state-error-primary)";

			const rowControls = (row, index) => {
				if (useSelect) {
					const value = keyOf(row);
					const children = [React.createElement("option", { key: "__empty", value: "" }, t("choose"))];
					for (const group of options) {
						children.push(React.createElement("optgroup", { key: group.group, label: group.label },
							group.models.map((model) => React.createElement("option", {
								key: model.value,
								value: model.value,
							}, model.label)),
						));
					}
					if (value !== "" && !known.has(value)) {
						children.push(React.createElement("option", { key: "__missing", value }, `${row.provider}/${row.model}${t("missing")}`));
					}
					return [React.createElement("select", {
						key: "pick",
						style: field,
						value,
						disabled: !writable || busy,
						"aria-label": `${t("slot")} ${index + 1}`,
						onChange: (event) => {
							const picked = event.target.value;
							if (picked === "") return edit(index, { provider: "", model: "" });
							const at = picked.indexOf(SEP);
							edit(index, { provider: picked.slice(0, at), model: picked.slice(at + 1) });
						},
					}, children)];
				}
				return [
					React.createElement("input", {
						key: "p",
						style: field,
						value: row.provider,
						disabled: !writable || busy,
						placeholder: t("providerPlaceholder"),
						"aria-label": `${t("provider")} ${index + 1}`,
						onChange: (event) => edit(index, { provider: event.target.value }),
					}),
					React.createElement("input", {
						key: "m",
						style: field,
						value: row.model,
						disabled: !writable || busy,
						placeholder: t("modelPlaceholder"),
						"aria-label": `${t("model")} ${index + 1}`,
						onChange: (event) => edit(index, { model: event.target.value }),
					}),
				];
			};

			const catalogLine = catalog.status === "ready"
				? React.createElement("p", { style: subtle },
					`${options.length} ${t("counts")} · ${modelCount} ${t("models")}`)
				: catalog.status === "error"
					? React.createElement("p", { style: subtle },
						`${t("catalogError")}：${catalog.error ?? ""} ${t("manual")} `,
						React.createElement("button", {
							type: "button",
							style: { ...button(false), height: 22, padding: "0 8px", fontSize: 12 },
							onClick: catalog.reload,
						}, t("retry")))
					: React.createElement("p", { style: subtle }, t("loading"));

			return React.createElement("div", { style: box },
				React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 4 } },
					React.createElement("h3", { style: { margin: 0, fontSize: 15, fontWeight: 500 } }, t("title")),
					React.createElement("p", { style: { margin: 0, color: "var(--dsw-alias-label-secondary)" } }, t("hint")),
					catalogLine,
				),
				React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 10 } },
					rows.map((row, index) => React.createElement("div", {
						key: index,
						style: { display: "flex", alignItems: "center", gap: 8 },
					},
						React.createElement("span", {
							style: { width: 72, color: "var(--dsw-alias-label-secondary)", flex: "none" },
						}, `${t("slot")} ${index + 1}`),
						...rowControls(row, index),
						React.createElement("button", {
							type: "button",
							style: { ...button(false), color: "var(--dsw-alias-label-secondary)" },
							disabled: !writable || busy || rows.length <= 1,
							title: t("remove"),
							onClick: () => remove(index),
						}, "×"),
					)),
					React.createElement("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
						React.createElement("button", {
							type: "button",
							style: button(false),
							disabled: !writable || busy,
							onClick: add,
						}, t("add")),
						React.createElement("button", {
							type: "button",
							style: button(true),
							disabled: !writable || busy || !useSelect,
							onClick: save,
						}, busy ? t("saving") : t("save")),
						React.createElement("button", {
							type: "button",
							style: { ...button(false), color: "var(--dsw-alias-label-secondary)" },
							disabled: !writable || busy,
							onClick: reset,
						}, t("reset")),
					),
				),
				React.createElement("p", { style: subtle },
					snap?.status === "loading" ? t("loadingSettings") : writable ? t("immediate") : t("readOnly")),
				noticeText === null ? null : React.createElement("p", {
					role: "status",
					style: { margin: 0, color: noticeColor, fontSize: 12 },
				}, noticeText),
			);
		}

		const inject = ["slots", "locale", "configForms", "remote", "remote.session"];

		function apply(ctx) {
			const t = ctx.locale.bind(LOCALE_NS);
			ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), "dsh-model-fallback: dictionaries");

			/** 读 Host 的模型目录：provider 分组 + 每个 provider 能选的模型。 */
			async function loadCatalog() {
				const response = await ctx.remote.session.modelCatalog();
				if (!response || response.ok !== true) {
					throw new Error(response?.error?.message ?? "modelCatalog failed");
				}
				return response.value.groups ?? [];
			}

			ctx.effect(() => ctx.configForms.whileServed([NS], () => ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "model-fallback",
				order: 46,
				label: () => t("nav"),
				locale: LOCALE_NS,
				inject: () => ({ t, form: ctx.configForms.get(NS), loadCatalog }),
			}, SettingsPanel))), "dsh-model-fallback: settings section");
		}

		exports.NS = NS;
		exports.SettingsPanel = SettingsPanel;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

