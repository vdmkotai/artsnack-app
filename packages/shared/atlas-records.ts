import { atlasDefaultValue, type AtlasParam, type AtlasParamValue } from "./atlas-models";

export type AtlasRecord = Record<string, AtlasParamValue>;

/** Records remain JSON strings in saved forms so existing clients and history stay readable. */
export function readAtlasRecords(value: AtlasParamValue | undefined): AtlasRecord[] {
  if (typeof value !== "string" || !value.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Invalid saved reference details");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((row) => !row || typeof row !== "object" || Array.isArray(row))
  ) {
    throw new Error("Reference details must be a list");
  }
  return parsed as AtlasRecord[];
}

export function defaultAtlasRecord(param: AtlasParam, index: number): AtlasRecord {
  const row: AtlasRecord = {};
  for (const field of param.fields ?? []) {
    if (field.name === "id") row.id = `subject${index + 1}`;
    else if (field.name === "ref_name") row.ref_name = `reference${index + 1}`;
    else if (field.name === "index") row.index = index + 1;
    else if (field.default !== undefined || field.required || field.kind === "enum")
      row[field.name] = atlasDefaultValue(field);
  }
  return row;
}

export function validateAtlasUrl(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} needs a public HTTP(S) URL`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} needs a public HTTP(S) URL`);
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password
  ) {
    throw new Error(`${label} needs a public HTTP(S) URL`);
  }
  return value.trim();
}

export function validateAtlasRecord(
  param: AtlasParam,
  row: AtlasRecord,
  index: number,
): AtlasRecord {
  const result: AtlasRecord = {};
  for (const field of param.fields ?? []) {
    const value =
      field.name === "index"
        ? index + 1
        : field.name === "ref_name" && !row[field.name]
          ? `reference${index + 1}`
          : row[field.name];
    const label = `${param.label} ${index + 1}: ${field.label}`;
    if (value === undefined || value === "") {
      if (field.required) throw new Error(`${label} is required`);
      continue;
    }
    if (field.options && !field.options.includes(value as string | number))
      throw new Error(`${label} is invalid`);
    if (field.kind === "integer" || field.kind === "number") {
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        (field.kind === "integer" && !Number.isInteger(value)) ||
        (field.min !== undefined && value < field.min) ||
        (field.max !== undefined && value > field.max)
      )
        throw new Error(`${label} is outside the supported range`);
    } else if (field.kind === "url-list") {
      if (!Array.isArray(value) || (field.maxItems !== undefined && value.length > field.maxItems))
        throw new Error(`${label} has too many URLs`);
      value.forEach((url) => validateAtlasUrl(url, label));
    } else if (field.kind === "url") validateAtlasUrl(value, label);
    else if (typeof value !== "string") throw new Error(`${label} must be text`);
    if (typeof value === "string" && field.maxLength && value.length > field.maxLength)
      throw new Error(`${label} is too long`);
    if (
      field.name === "ref_name" &&
      typeof value === "string" &&
      new TextEncoder().encode(value).length > 30
    )
      throw new Error(`${label} exceeds 30 UTF-8 bytes`);
    if (field.name === "id" && typeof value === "string" && /\s|@/.test(value))
      throw new Error(`${label} cannot contain spaces or @`);
    result[field.name] = value;
  }
  return result;
}

/** Keep subject/type metadata bound to the same attachment when selection changes. */
export function remapAtlasReferenceDetails(
  model: import("./atlas-models").AtlasModel,
  params: Record<string, AtlasParamValue>,
  previousIds: readonly string[],
  nextIds: readonly string[],
): Record<string, AtlasParamValue> {
  const next = { ...params };
  for (const param of model.params.filter((entry) => entry.kind === "image-record-list")) {
    const key = `${param.name}_details`;
    const stored = readAtlasRecords(params[key]);
    const oldRows = previousIds.map((_, i) => ({ ...defaultAtlasRecord(param, i), ...stored[i] }));
    const usedIds = new Set(oldRows.map((row) => row.id));
    const usedNames = new Set(oldRows.map((row) => row.ref_name));
    next[key] = JSON.stringify(
      nextIds.map((id, index) => {
        const oldIndex = previousIds.indexOf(id);
        if (oldIndex >= 0) return oldRows[oldIndex];
        const row = defaultAtlasRecord(param, index);
        if (row.id) {
          let suffix = index + 1;
          while (usedIds.has(`subject${suffix}`)) suffix++;
          row.id = `subject${suffix}`;
          usedIds.add(row.id);
        }
        if (row.ref_name) {
          let suffix = index + 1;
          while (usedNames.has(`reference${suffix}`)) suffix++;
          row.ref_name = `reference${suffix}`;
          usedNames.add(row.ref_name);
        }
        return row;
      }),
    );
  }
  return next;
}
