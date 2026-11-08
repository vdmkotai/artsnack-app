/**
 * What the native app runs of the web's shared TypeScript, bundled by
 * crates/rules/build.rs (`bun build … --format iife`) and evaluated in QuickJS.
 *
 * Each module is exposed under its own name, so `promptEnhance.ENHANCE_MODELS`
 * on the Rust side is exactly `ENHANCE_MODELS` from packages/shared/prompt-enhance.ts.
 * Values cross the boundary as JSON: `__get(path)` reads a value, `__call(path,
 * argsJson)` calls a function with the arguments array.
 *
 * Add a module here when a native screen needs it; never copy its logic into Rust.
 */
// First, so the web globals QuickJS lacks exist before any module runs.
import "./globals";
import * as grokPrompt from "../../../../../packages/shared/grok-prompt";
import * as h3Video from "../../../../../packages/shared/h3-video";
import * as imageKey from "../../../../../packages/shared/image-key";
import * as imageToPrompt from "../../../../../packages/shared/image-to-prompt";
import * as ltxVideo from "../../../../../packages/shared/ltx-video";
import * as promptEnhance from "../../../../../packages/shared/prompt-enhance";
import * as promptStudio from "../../../../../packages/shared/prompt-studio";
import * as referenceProfile from "../../../../../packages/shared/reference-profile";

const modules: Record<string, Record<string, unknown>> = {
  grokPrompt,
  h3Video,
  imageKey,
  imageToPrompt,
  ltxVideo,
  promptEnhance,
  promptStudio,
  referenceProfile,
};

function resolve(path: string): unknown {
  const [module, ...rest] = path.split(".");
  let value: unknown = modules[module];
  for (const key of rest) {
    if (value === undefined || value === null) break;
    value = (value as Record<string, unknown>)[key];
  }
  if (value === undefined) throw new Error(`packages/shared has no export ${path}`);
  return value;
}

(globalThis as Record<string, unknown>).ArtsnackShared = {
  __get(path: string): string {
    return JSON.stringify(resolve(path));
  },
  __call(path: string, argsJson: string): string {
    const fn = resolve(path);
    if (typeof fn !== "function") throw new Error(`${path} is not a function`);
    const result = (fn as (...args: unknown[]) => unknown)(...(JSON.parse(argsJson) as unknown[]));
    return JSON.stringify(result === undefined ? null : result);
  },
};
