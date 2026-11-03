export type AmazonConsoleErrorInput = {
  type: string;
  text: string;
  sourceUrl?: string | null;
};

export type AmazonConsoleErrorDiagnostic = {
  type: "error";
  sourceDomain: string | null;
  sourceKind: "amazon_first_party" | "third_party" | "inline_or_unknown";
  messageCategory:
    | "blocked_resource"
    | "content_security_policy"
    | "network_resource"
    | "script_exception"
    | "third_party_script"
    | "other_console_error";
  affectsExtractor: boolean | null;
  affectsPageStatus: boolean | null;
  impactAssessment: "not_attributable_from_console_message";
};

export type AmazonConsoleErrorSummary = {
  schemaVersion: "amazon-console-error-summary.v1";
  totalErrors: number;
  recordedErrors: number;
  truncatedErrors: number;
  items: AmazonConsoleErrorDiagnostic[];
};

const DEFAULT_MAX_ENTRIES = 20;
const HARD_MAX_ENTRIES = 50;

function safeSourceDomain(sourceUrl: string | null | undefined): { domain: string | null; kind: AmazonConsoleErrorDiagnostic["sourceKind"] } {
  if (typeof sourceUrl !== "string" || !sourceUrl.trim() || /^(?:inline|about:blank)/i.test(sourceUrl)) {
    return { domain: null, kind: "inline_or_unknown" };
  }
  try {
    const url = new URL(sourceUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return { domain: null, kind: "inline_or_unknown" };
    const domain = url.hostname.toLowerCase().replace(/[^a-z0-9.-]/g, "").slice(0, 253) || null;
    if (!domain) return { domain: null, kind: "inline_or_unknown" };
    const amazonOwnedDomain = ["amazon.com", "media-amazon.com", "ssl-images-amazon.com", "amazon-adsystem.com"]
      .some((base) => domain === base || domain.endsWith(`.${base}`));
    return { domain, kind: amazonOwnedDomain ? "amazon_first_party" : "third_party" };
  } catch {
    return { domain: null, kind: "inline_or_unknown" };
  }
}

function classifyMessage(text: string, sourceKind: AmazonConsoleErrorDiagnostic["sourceKind"]): AmazonConsoleErrorDiagnostic["messageCategory"] {
  const bounded = text.slice(0, 800).toLowerCase();
  if (/content security policy|\bcsp\b/.test(bounded)) return "content_security_policy";
  if (/err_blocked_by_client|blocked by client|net::err_blocked/.test(bounded)) return "blocked_resource";
  if (/failed to load resource|net::err_|networkerror|load failed|request failed|http error/.test(bounded)) return "network_resource";
  if (/uncaught (?:exception|error)|referenceerror|typeerror|syntaxerror|rangeerror|unhandledrejection/.test(bounded)) return "script_exception";
  if (sourceKind === "third_party") return "third_party_script";
  return "other_console_error";
}

export function classifyAmazonConsoleError(input: AmazonConsoleErrorInput): AmazonConsoleErrorDiagnostic | null {
  if (input.type !== "error") return null;
  const source = safeSourceDomain(input.sourceUrl);
  return {
    type: "error",
    sourceDomain: source.domain,
    sourceKind: source.kind,
    messageCategory: classifyMessage(typeof input.text === "string" ? input.text : "", source.kind),
    // A ConsoleMessage does not establish causality. Keep impact explicitly unknown
    // rather than treating every third-party error as a collector or page failure.
    affectsExtractor: null,
    affectsPageStatus: null,
    impactAssessment: "not_attributable_from_console_message",
  };
}

export class AmazonConsoleErrorCollector {
  private totalErrors = 0;
  private readonly items: AmazonConsoleErrorDiagnostic[] = [];
  private readonly maxEntries: number;

  constructor(maxEntries = DEFAULT_MAX_ENTRIES) {
    this.maxEntries = Number.isFinite(maxEntries)
      ? Math.max(0, Math.min(HARD_MAX_ENTRIES, Math.floor(maxEntries)))
      : DEFAULT_MAX_ENTRIES;
  }

  record(input: AmazonConsoleErrorInput): void {
    const diagnostic = classifyAmazonConsoleError(input);
    if (!diagnostic) return;
    this.totalErrors += 1;
    if (this.items.length < this.maxEntries) this.items.push(diagnostic);
  }

  snapshot(): AmazonConsoleErrorSummary {
    return {
      schemaVersion: "amazon-console-error-summary.v1",
      totalErrors: this.totalErrors,
      recordedErrors: this.items.length,
      truncatedErrors: Math.max(0, this.totalErrors - this.items.length),
      items: this.items.map((item) => ({ ...item })),
    };
  }
}
