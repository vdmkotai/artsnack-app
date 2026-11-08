import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { b2Region } from "@/lib/b2-region";

const B2_KEY_ID = process.env.B2_KEY_ID!;
const B2_APP_KEY = process.env.B2_APP_KEY!;
const B2_BUCKET_NAME = process.env.B2_BUCKET_NAME!;
const B2_ENDPOINT = process.env.B2_ENDPOINT!;

let s3Client: S3Client | null = null;

function getS3Client(): S3Client {
  if (!s3Client) {
    if (!B2_KEY_ID || !B2_APP_KEY || !B2_BUCKET_NAME || !B2_ENDPOINT) {
      throw new Error("Missing B2 environment variables");
    }

    s3Client = new S3Client({
      endpoint: `https://${B2_ENDPOINT}`,
      region: b2Region(B2_ENDPOINT, process.env.B2_REGION),
      credentials: {
        accessKeyId: B2_KEY_ID,
        secretAccessKey: B2_APP_KEY,
      },
    });
  }
  return s3Client;
}

/**
 * Upload an image buffer to B2
 * @param buffer - Image data as Buffer or Uint8Array
 * @param key - Object key (e.g., "generations/1234567890_0.png")
 * @param contentType - MIME type (default: "image/png")
 * @returns The key that was uploaded
 */
export async function uploadImage(
  buffer: Buffer | Uint8Array,
  key: string,
  contentType: string = "image/png",
): Promise<string> {
  const client = getS3Client();

  await client.send(
    new PutObjectCommand({
      Bucket: B2_BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    }),
  );

  return key;
}

/**
 * Get an image from B2 as a readable stream
 * @param key - Object key
 * @returns Object with body stream and content type
 */
export async function getImage(
  key: string,
): Promise<{ body: ReadableStream; contentType: string }> {
  const client = getS3Client();

  const response = await client.send(
    new GetObjectCommand({
      Bucket: B2_BUCKET_NAME,
      Key: key,
    }),
  );

  if (!response.Body) {
    throw new Error("No body in response");
  }

  const webStream = response.Body.transformToWebStream();

  return {
    body: webStream,
    contentType: response.ContentType || "image/png",
  };
}

/**
 * Generate a unique key for a generation image
 * @param index - Image index in batch
 * @returns Key string like "generations/1234567890123_0.png"
 */
export function generateImageKey(index: number): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return `generations/${timestamp}_${random}_${index}.png`;
}
