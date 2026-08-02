import { javascript } from "@codemirror/lang-javascript";
import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { CheckCircle2, Play, Save, Workflow } from "lucide-react";
import { useEffect, useRef } from "react";
import { useStore } from "../store";
import { OutlineFlow } from "./OutlineFlow";
import { SplitGroup, SplitHandle, SplitPane } from "./Split";
import { Button, Panel } from "./ui";

export function Authoring() {
  const script = useStore((s) => s.script);
  const argsText = useStore((s) => s.argsText);
  const parse = useStore((s) => s.parse);
  const notice = useStore((s) => s.notice);
  const focusLine = useStore((s) => s.focusLine);
  const setScript = useStore((s) => s.setScript);
  const setArgsText = useStore((s) => s.setArgsText);
  const validate = useStore((s) => s.validate);
  const start = useStore((s) => s.start);
  const openSaveDialog = useStore((s) => s.openSaveDialog);
  const view = useRef<EditorView | null>(null);

  // Debounced validation: the analyzer is cheap (one acorn parse) but the
  // editor fires per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => void validate(), 400);
    return () => clearTimeout(timer);
  }, [script, validate]);

  // Clicking a node in the static graph reveals the call it was derived from.
  useEffect(() => {
    const editor = view.current;
    if (!editor || focusLine === null) return;
    if (focusLine > editor.state.doc.lines) return;
    const line = editor.state.doc.line(focusLine);
    editor.dispatch({
      selection: { anchor: line.from, head: line.to },
      effects: EditorView.scrollIntoView(line.from, { y: "center" }),
    });
    editor.focus();
  }, [focusLine]);

  const outline = parse?.outline;

  return (
    <SplitGroup id="authoring" orientation="vertical">
      <SplitPane id="editor" defaultSize="64%" minSize="120px">
        <Panel
          title="编排 · 脚本"
          className="h-full min-h-0"
          right={
            <>
              <Button onClick={() => void openSaveDialog()} title="保存为斜杠命令(可选项目级 / 个人级)">
                <Save className="inline size-3" /> 保存
              </Button>
              <Button tone="primary" onClick={() => void start()}>
                <Play className="inline size-3" /> 运行
              </Button>
            </>
          }
        >
          <div className="flex h-full min-h-0 flex-col">
            <div className="min-h-0 flex-1">
              <CodeMirror
                value={script}
                theme="dark"
                height="100%"
                className="h-full"
                extensions={[javascript({ typescript: false })]}
                basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true }}
                onCreateEditor={(editor) => {
                  view.current = editor;
                }}
                onChange={setScript}
              />
            </div>
            <div className="shrink-0 border-t border-ink-600 p-2">
              <div className="mb-1 text-[11px] tracking-wider text-ink-300 uppercase">args (JSON)</div>
              <textarea
                value={argsText}
                onChange={(event) => setArgsText(event.target.value)}
                rows={2}
                spellCheck={false}
                className="w-full resize-y rounded border border-ink-600 bg-ink-950 p-1.5 text-[12px] outline-none focus:border-accent"
              />
              {parse && !parse.ok && <div className="mt-1 text-[12px] text-bad">脚本无效:{parse.error}</div>}
              {parse?.ok && parse.meta && (
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-ink-300">
                  <CheckCircle2 className="size-3 text-ok" />
                  <span className="font-mono text-ink-100">{parse.meta.name}</span>
                  <span>phases {parse.meta.phases?.length ?? 0}</span>
                  {outline && (
                    <>
                      <span>静态 agent 调用点 {outline.agentCallSites}</span>
                      <span className={outline.hasDynamicFanout ? "text-busy" : "text-ok"}>
                        {outline.hasDynamicFanout ? "含动态扇出 → 实际数量运行时决定" : "无动态扇出"}
                      </span>
                    </>
                  )}
                </div>
              )}
              {notice && (
                <div className={notice.kind === "error" ? "mt-1 text-[12px] text-bad" : "mt-1 text-[12px] text-ok"}>
                  {notice.text}
                </div>
              )}
            </div>
          </div>
        </Panel>
      </SplitPane>

      <SplitHandle orientation="vertical" />

      <SplitPane id="outline" defaultSize="36%" minSize="80px">
        <Panel
          title="静态结构(设计期推断)"
          className="h-full min-h-0"
          right={<Workflow className="size-3 text-ink-300" />}
        >
          <div className="h-full">{outline ? <OutlineFlow outline={outline} /> : null}</div>
        </Panel>
      </SplitPane>
    </SplitGroup>
  );
}
