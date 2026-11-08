"use client";

import { Button } from "@/components/ui/button";
import { parseAspectOption } from "@/lib/atlas-control-presentation";

export function AspectRatioOptions({
  options,
  value,
  label,
  disabled,
  onChange,
}: {
  options: readonly { value: string; label: string; aspect?: number | null }[];
  value: string;
  label: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="grid grid-cols-[repeat(auto-fit,minmax(4rem,1fr))] gap-1"
    >
      {options.map((option) => {
        const aspect = option.aspect ?? parseAspectOption(option.label);
        return (
          <Button
            key={option.value}
            variant={option.value === value ? "secondary" : "ghost"}
            aria-pressed={option.value === value}
            aria-label={`${label} ${option.label}`}
            disabled={disabled}
            className="h-16 min-w-0 flex-col gap-1 rounded-md border px-1 text-xs font-normal"
            onClick={() => onChange(option.value)}
          >
            <span className="flex h-7 items-center justify-center" aria-hidden="true">
              <span
                className="block rounded-[2px] border border-current"
                style={{
                  width: `${24 * Math.min(1, aspect ?? 1)}px`,
                  height: `${24 / Math.max(1, aspect ?? 1)}px`,
                  borderStyle: aspect === null ? "dashed" : "solid",
                }}
              />
            </span>
            {option.label}
          </Button>
        );
      })}
    </div>
  );
}
