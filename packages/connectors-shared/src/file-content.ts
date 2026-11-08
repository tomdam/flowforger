/**
 * File content shaping shared by the file-serving connectors (SharePoint, OneDrive, ...).
 *
 * Logic Apps content handling decides what the next action sees from a downloaded
 * file by its content type; the local connectors reproduce that rule so a flow
 * reads the same value under `flowforger run` as in the cloud.
 */

/** Base64 envelope Logic Apps uses for non-text bodies (note the cloud key is `$content-type`). */
export type FileContentEnvelope = { '$content-type': string; $content: string };

/** What "Get file content" hands the next action: parsed JSON, plain text, or the base64 envelope. */
export type FileContentResult = string | unknown | FileContentEnvelope;

/**
 * Shape downloaded bytes the way Logic Apps content handling does for the
 * given content type: `application/json` is parsed (falls back to text if it
 * is not valid JSON), `text/*` is the UTF-8 text, and everything else stays
 * the base64 envelope. This is why an .xml file shows up as XML source in a
 * Power Automate run (its inferred type is `text/xml`), while a .pdf shows up
 * as `{ "$content-type": "application/pdf", "$content": "..." }`.
 */
export function toCloudFileContent(base64: string, contentType: string): FileContentResult {
  const mediaType = contentType.split(';')[0].trim().toLowerCase();
  const isJson = mediaType === 'application/json';
  if (!isJson && !mediaType.startsWith('text/')) {
    return { '$content-type': contentType, $content: base64 };
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const text = new TextDecoder('utf-8').decode(bytes);
  if (!isJson) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
