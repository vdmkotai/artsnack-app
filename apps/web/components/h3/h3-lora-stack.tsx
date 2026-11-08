"use client";

import { Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Slider } from "@/components/ui/slider";
import { H3_LIMITS, type H3Lora } from "@/lib/h3-video";

/**
 * H3 LoRAs load through LoraLoaderModelOnly — the text encoder is a separate
 * Qwen3-VL that LoRAs do not touch — so each slot has one strength, not the
 * image tab's model/CLIP pair. Merged community checkpoints usually want
 * 0.2–0.6; the official ones take 1.0.
 */
export function H3LoraStack({
  loras,
  available,
  onChange,
}: {
  loras: H3Lora[];
  available: string[];
  onChange: (next: H3Lora[]) => void;
}) {
  const update = (index: number, patch: Partial<H3Lora>) =>
    onChange(loras.map((lora, i) => (i === index ? { ...lora, ...patch } : lora)));
  const strength = (value: number | readonly number[]) =>
    Math.round((Array.isArray(value) ? value[0] : (value as number)) * 100) / 100;

  return (
    <div className="space-y-2">
      {loras.map((lora, index) => (
        <div key={index} className="space-y-2 rounded-lg border bg-card p-3">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <SearchableSelect
                value={lora.name}
                onValueChange={(name) => update(index, { name })}
                options={available}
                placeholder="Select LoRA…"
                emptyMessage="No H3 LoRAs on the pod yet"
              />
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Remove LoRA"
              onClick={() => onChange(loras.filter((_, i) => i !== index))}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex items-center gap-3">
            <Slider
              value={[lora.strength]}
              min={H3_LIMITS.loraStrength.min}
              max={H3_LIMITS.loraStrength.max}
              step={0.05}
              onValueChange={(value) => update(index, { strength: strength(value) })}
            />
            <Input
              type="number"
              step={0.05}
              className="h-7 w-20 text-xs"
              value={lora.strength}
              onChange={(event) => update(index, { strength: Number(event.target.value) || 0 })}
            />
          </div>
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        className="w-full"
        disabled={loras.length >= H3_LIMITS.loras}
        onClick={() => onChange([...loras, { name: available[0] ?? "", strength: 0.5 }])}
      >
        <Plus className="h-4 w-4" /> Add LoRA
      </Button>
    </div>
  );
}
