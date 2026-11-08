import * as Crypto from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";

/** A draft owns its image bytes; generation storage is disposable. */
export type Reference = {
  id: string;
  uri: string;
  width?: number;
  height?: number;
  bytes?: number;
  selected?: boolean;
};

export function referenceUri(id: string) {
  return new File(Paths.document, "references", `${id}.jpg`).uri;
}

export async function retainReference(uri: string): Promise<Reference> {
  const context = ImageManipulator.manipulate(uri);
  const image = await context.renderAsync();
  const saved = await image.saveAsync({ compress: 1, format: SaveFormat.JPEG });
  const id = Crypto.randomUUID();
  new Directory(Paths.document, "references").create({ intermediates: true, idempotent: true });
  const file = new File(referenceUri(id));
  new File(saved.uri).move(file);
  return { id, uri: file.uri, width: image.width, height: image.height, bytes: file.size };
}

export function loadReferences(raw?: string): Reference[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is Reference =>
          entry !== null &&
          typeof entry === "object" &&
          typeof entry.id === "string" &&
          /^[a-zA-Z0-9-]+$/.test(entry.id),
      )
      .map((entry) => ({ ...entry, uri: referenceUri(entry.id) }));
  } catch {
    return [];
  }
}
