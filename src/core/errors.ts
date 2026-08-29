/**
 * google-search-console-mcp-server: an open-source MCP server for Google Search Console.
 * Copyright 2026 GetMCPAds. https://www.getmcpads.com
 * SPDX-License-Identifier: Apache-2.0
 */
export class PlatformApiError extends Error {
  constructor(
    public readonly platform: string,
    public readonly code: number,
    message: string,
    public readonly isRateLimit: boolean = false,
    public readonly isAuth: boolean = false,
    public readonly isPermission: boolean = false,
    public readonly suggestion: string = "",
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = "PlatformApiError";
  }

  toMcpError() {
    return {
      error: this.message,
      platform: this.platform,
      code: this.code,
      isRateLimit: this.isRateLimit,
      isAuth: this.isAuth,
      isPermission: this.isPermission,
      suggestion: this.suggestion,
      ...(this.retryAfter !== undefined && { retryAfter: this.retryAfter }),
    };
  }
}

export function formatMcpToolError(error: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  if (error instanceof PlatformApiError) {
    return {
      content: [{ type: "text", text: JSON.stringify(error.toMcpError(), null, 2) }],
      isError: true,
    };
  }

  const apiError = error as {
    code?: number;
    status?: string;
    suggestion?: string;
    message?: string;
    isAuthError?: boolean;
    isRateLimitError?: boolean;
    isQuotaError?: boolean;
  };

  if (typeof apiError?.code === "number" || apiError?.status) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: apiError.message ?? "Google Search Console API error",
          platform: "gsc",
          code: apiError.code,
          status: apiError.status,
          isAuth: Boolean(apiError.isAuthError),
          isRateLimit: Boolean(apiError.isRateLimitError || apiError.isQuotaError),
          suggestion: apiError.suggestion,
        }, null, 2),
      }],
      isError: true,
    };
  }

  const msg = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: JSON.stringify({ error: msg }, null, 2) }], isError: true };
}
