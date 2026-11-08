"use client";

import { Button } from "@/components/ui/button";

/** Same selection control for vendor enums, bounded counts and app-owned request counts. */
export function ChoiceOptions({
  options,
  value,
  onChange,
  label,
  disabled,
  format = String,
  price,
  segmented,
}: {
  options: readonly (string | number)[];
  value: string | number | boolean | string[];
  onChange: (value: string | number) => void;
  label: string;
  disabled?: boolean;
  format?: (value: string | number) => string;
  price?: (value: string | number) => string | null;
  /** Buttons rather than a dropdown. Defaults to buttons for eight options or fewer. */
  segmented?: boolean;
}) {
  // Resolved here rather than as a parameter default: the React Compiler cannot
  // reorder a default that reads another parameter, and skips the component.
  const asButtons = segmented ?? options.length <= 8;
  if (!asButtons)
    return (
      <select
        aria-label={label}
        disabled={disabled}
        value={options.findIndex((option) => option === value)}
        onChange={(event) => {
          const option = options[Number(event.target.value)];
          if (option !== undefined) onChange(option);
        }}
        className="h-8 min-w-0 max-w-full rounded-md border bg-card px-2 text-xs disabled:opacity-50"
      >
        {options.map((option, index) => (
          <option key={`${typeof option}:${option}`} value={index}>
            {format(option)}
            {price?.(option) ? ` · ${price(option)}` : ""}
          </option>
        ))}
      </select>
    );
  return (
    <div
      role="group"
      aria-label={label}
      className="flex flex-wrap items-center gap-0.5 rounded-md border bg-card p-0.5"
    >
      {options.map((option) => (
        <Button
          key={`${typeof option}:${option}`}
          variant={option === value ? "default" : "ghost"}
          size="sm"
          aria-pressed={option === value}
          disabled={disabled}
          className="h-7 min-w-0 px-2 text-xs font-normal"
          onClick={() => onChange(option)}
        >
          {format(option)}
          {price?.(option) && <span className="ml-1 opacity-70">{price(option)}</span>}
        </Button>
      ))}
    </div>
  );
}
