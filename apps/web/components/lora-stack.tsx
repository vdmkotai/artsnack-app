"use client";

import * as React from "react";
import { LoraSlot } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";

interface LoraStackProps {
  loras: LoraSlot[];
  availableLoras: string[];
  onChange: (loras: LoraSlot[]) => void;
}

const DEFAULT_LORA: LoraSlot = {
  enabled: false,
  loraName: "",
  strengthModel: 1,
  strengthClip: 1,
};

function StrengthInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [draft, setDraft] = React.useState<string>(String(value));
  const [focused, setFocused] = React.useState(false);

  React.useEffect(() => {
    if (!focused) setDraft(String(value));
  }, [value, focused]);

  return (
    <Input
      type="text"
      inputMode="decimal"
      value={focused ? draft : String(value)}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === "" || raw === "-" || /^-?\d*\.?\d*$/.test(raw)) {
          setDraft(raw);
          const n = parseFloat(raw);
          if (!isNaN(n)) onChange(n);
        }
      }}
      onFocus={() => {
        setFocused(true);
        setDraft(String(value));
      }}
      onBlur={() => {
        setFocused(false);
        const n = parseFloat(draft);
        onChange(isNaN(n) ? 1 : Math.min(10, Math.max(-10, n)));
      }}
      className="w-20 h-7 text-xs font-mono text-left"
    />
  );
}

export function LoraStack({ loras, availableLoras, onChange }: LoraStackProps) {
  // Ensure we always have 10 slots to render
  const slots = React.useMemo(() => {
    const safeArray = Array.isArray(loras) ? loras : [];
    const result = [...safeArray];
    while (result.length < 10) {
      result.push({ ...DEFAULT_LORA });
    }
    return result.slice(0, 10);
  }, [loras]);

  const activeCount = slots.filter((l) => l.enabled).length;

  const updateSlot = (index: number, updates: Partial<LoraSlot>) => {
    const newLoras = [...slots];
    newLoras[index] = { ...newLoras[index], ...updates };
    onChange(newLoras);
  };

  const handleStrengthChange = (
    index: number,
    field: "strengthModel" | "strengthClip",
    value: number | readonly number[],
  ) => {
    const numValue = Array.isArray(value) ? value[0] : value;
    updateSlot(index, { [field]: numValue });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-foreground">LoRA Stack</h3>
        <Badge variant="secondary" className="text-xs">
          {activeCount}/10 Active
        </Badge>
      </div>

      <div className="space-y-3">
        {slots.map((slot, index) => (
          <div
            key={index}
            className={cn(
              "rounded-lg border bg-card p-3 transition-[opacity,border-color,box-shadow] duration-200",
              slot.enabled
                ? "border-primary/50 shadow-sm"
                : "border-border/50 opacity-60 hover:opacity-80",
            )}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <Switch
                  checked={slot.enabled}
                  onCheckedChange={(checked) => updateSlot(index, { enabled: checked })}
                  id={`lora-switch-${index}`}
                />
                <Label
                  htmlFor={`lora-switch-${index}`}
                  className={cn(
                    "cursor-pointer font-medium",
                    !slot.enabled && "text-muted-foreground",
                  )}
                >
                  Slot {index + 1}
                </Label>
              </div>

              {!slot.enabled && slot.loraName && (
                <span className="text-xs text-muted-foreground truncate max-w-[150px]">
                  {slot.loraName}
                </span>
              )}
            </div>

            {slot.enabled && (
              <div className="mt-4 space-y-4 animate-in slide-in-from-top-2 fade-in duration-200">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Model</Label>
                  <SearchableSelect
                    value={slot.loraName}
                    onValueChange={(val) => updateSlot(index, { loraName: val || "" })}
                    options={availableLoras}
                    placeholder="Select LoRA..."
                    emptyMessage="No LoRAs found."
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <div className="flex justify-between items-center">
                      <Label className="text-xs text-muted-foreground">Model Strength</Label>
                      <StrengthInput
                        value={Number(slot.strengthModel)}
                        onChange={(val) => updateSlot(index, { strengthModel: val })}
                      />
                    </div>
                    <Slider
                      value={[Number(slot.strengthModel)]}
                      min={-10}
                      max={10}
                      step={0.1}
                      onValueChange={(vals) => handleStrengthChange(index, "strengthModel", vals)}
                    />
                  </div>

                  <div className="space-y-2">
                    <div className="flex justify-between items-center">
                      <Label className="text-xs text-muted-foreground">CLIP Strength</Label>
                      <StrengthInput
                        value={Number(slot.strengthClip)}
                        onChange={(val) => updateSlot(index, { strengthClip: val })}
                      />
                    </div>
                    <Slider
                      value={[Number(slot.strengthClip)]}
                      min={-10}
                      max={10}
                      step={0.1}
                      onValueChange={(vals) => handleStrengthChange(index, "strengthClip", vals)}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
