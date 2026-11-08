// LoRA slot configuration
export interface LoraSlot {
  enabled: boolean;
  loraName: string;
  strengthModel: number | string;
  strengthClip: number | string;
}

// Complete form state for generation
export interface GenerateFormState {
  prompt: string;
  negativePrompt: string;
  checkpoint: string;
  width: number | string;
  height: number | string;
  seed: number | string;
  steps: number | string;
  cfg: number | string;
  sampler: string;
  scheduler: string;
  denoise: number | string;
  batchSize: number | string;
  loras: LoraSlot[];
}

// A single generation entry (can have multiple images)
export interface GenerationEntry {
  id: string;
  timestamp: number;
  formState: GenerateFormState; // Complete snapshot of all settings
  imageUrls: string[]; // 1-4 images
}
