export interface HealthCheckResult {
  online: boolean;
  latency?: number;
  error?: string;
}

export interface GenerationImage {
  url: string;
  filename: string;
}

export interface GenerationResult {
  success: boolean;
  promptId?: string;
  images?: GenerationImage[];
  b2Keys?: string[];
  error?: string;
}

export interface GenerationStatus {
  completed: boolean;
  error?: string;
}

export type GenerationWorkflow = Record<string, unknown>;

export interface GenerationBackend {
  healthCheck(): Promise<HealthCheckResult>;
  generate(workflow: GenerationWorkflow, clientId?: string): Promise<{ promptId: string }>;
  checkStatus(promptId: string): Promise<GenerationStatus>;
  getResult(promptId: string): Promise<GenerationResult>;
}
