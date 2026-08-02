import clsx from "clsx";
import { FolderGit2, UserRound } from "lucide-react";
import { useStore } from "../store";
import { Button } from "./ui";

/**
 * Destination picker for saved workflows. omp keeps two scopes and resolves
 * project > user, so the target is a real decision, not a detail: a project
 * workflow is committed with the repo it automates and shadows a personal one
 * of the same name.
 */
export function SaveDialog() {
  const dialog = useStore((s) => s.saveDialog);
  const close = useStore((s) => s.closeSaveDialog);
  const patch = useStore((s) => s.patchSaveDialog);
  const commit = useStore((s) => s.commitSave);
  if (!dialog) return null;

  const nameValid = dialog.name.length > 0 && !/[/\\\0]/.test(dialog.name);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="w-[560px] rounded-lg border border-ink-600 bg-ink-800 shadow-2xl">
        <div className="border-b border-ink-600 px-4 py-2 text-[13px] tracking-wider text-ink-300 uppercase">
          保存工作流
        </div>
        <div className="space-y-3 p-4">
          <label className="block">
            <span className="mb-1 block text-[11px] tracking-wider text-ink-300 uppercase">
              命令名(注册为 /名称)
            </span>
            <input
              autoFocus
              value={dialog.name}
              onChange={(event) => void patch({ name: event.target.value })}
              className="w-full rounded border border-ink-600 bg-ink-950 px-2 py-1 text-[13px] outline-none focus:border-accent"
            />
            {!nameValid && <span className="text-[11px] text-bad">名称不能为空,且不能包含 / 或 \</span>}
          </label>

          <label className="block">
            <span className="mb-1 block text-[11px] tracking-wider text-ink-300 uppercase">描述</span>
            <input
              value={dialog.description}
              onChange={(event) => void patch({ description: event.target.value })}
              placeholder="留空则取脚本 meta.description"
              className="w-full rounded border border-ink-600 bg-ink-950 px-2 py-1 text-[13px] outline-none focus:border-accent"
            />
          </label>

          <div>
            <span className="mb-1 block text-[11px] tracking-wider text-ink-300 uppercase">保存位置</span>
            <div className="space-y-1.5">
              {dialog.options.map((option) => {
                const selected = option.location === dialog.location;
                const overwrite = dialog.existing.includes(option.location);
                const Icon = option.location === "project" ? FolderGit2 : UserRound;
                return (
                  <button
                    key={option.location}
                    type="button"
                    onClick={() => void patch({ location: option.location })}
                    className={clsx(
                      "flex w-full items-start gap-2 rounded border px-2.5 py-2 text-left transition-colors",
                      selected ? "border-accent bg-accent/10" : "border-ink-600 bg-ink-850 hover:border-accent/60",
                    )}
                  >
                    <Icon className={clsx("mt-0.5 size-3.5", selected ? "text-accent" : "text-ink-300")} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="text-[13px]">
                          {option.label === "Project" ? "项目级" : "个人级"}
                          <span className="ml-1 text-ink-300">{option.label}</span>
                        </span>
                        {overwrite && (
                          <span className="rounded bg-busy/15 px-1 text-[10px] text-busy">已存在 · 覆盖</span>
                        )}
                        {option.location === "project" && (
                          <span className="ml-auto text-[10px] text-ink-300">优先级高,可随仓库提交</span>
                        )}
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] text-ink-300">{option.dir}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <p className="text-[11px] text-ink-300">
            保存后立即注册为斜杠命令 <span className="text-accent">/{dialog.name || "name"}</span>
            ;同名时项目级覆盖个人级,并遮蔽同名内置模式。
          </p>
        </div>
        <div className="flex justify-end gap-2 border-t border-ink-600 px-4 py-2">
          <Button onClick={close}>取消</Button>
          <Button tone="primary" disabled={!nameValid} onClick={() => void commit()}>
            保存
          </Button>
        </div>
      </div>
    </div>
  );
}
