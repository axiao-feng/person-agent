export type GmailPart = {
  mimeType?: string;
  filename?: string;
  body?: {
    data?: string;
    size?: number;
    attachmentId?: string;
  };
  parts?: GmailPart[];
};

export type MailAttachment = {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string | null;
};

export function extractMimeBody(payload: GmailPart | undefined, maximum = 20_000): {
  text: string;
  attachments: MailAttachment[];
  truncated: boolean;
} {
  if (!payload) return { text: "", attachments: [], truncated: false };
  const plain: string[] = [];
  const html: string[] = [];
  const attachments: MailAttachment[] = [];
  walk(payload, plain, html, attachments);
  const fullText = normalizeWhitespace(plain.length ? plain.join("\n\n") : htmlToText(html.join("\n")));
  return {
    text: fullText.slice(0, maximum),
    attachments,
    truncated: fullText.length > maximum,
  };
}

function walk(
  part: GmailPart,
  plain: string[],
  html: string[],
  attachments: MailAttachment[],
): void {
  const filename = part.filename?.trim();
  if (filename) {
    attachments.push({
      filename,
      mimeType: part.mimeType || "application/octet-stream",
      size: part.body?.size ?? 0,
      attachmentId: part.body?.attachmentId ?? null,
    });
  } else if (part.body?.data) {
    const decoded = decodeBase64Url(part.body.data);
    if (part.mimeType === "text/plain") plain.push(decoded);
    else if (part.mimeType === "text/html") html.push(decoded);
  }
  for (const child of part.parts ?? []) walk(child, plain, html, attachments);
}

function decodeBase64Url(value: string): string {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return "";
  }
}

function htmlToText(value: string): string {
  return decodeEntities(
    value
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  );
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return named[entity.toLowerCase()] ?? match;
  });
}

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
