const env = import.meta.env;

export interface AppConfig {
  /** OAuth Web client ID; empty = demo only. */
  googleClientId: string;
  orgDomain: string;
  /** Base URL of the assistant API, or '' when none is connected. */
  assistantUrl: string;
  /** Base URL of the shared notes API, or '' to keep notes on this device. */
  notesUrl: string;
  /** Endpoint that checks a signed-in Google account against Axal VC members, or ''. */
  sessionUrl: string;
  /** Endpoint that files bug reports as GitHub issues, or ''. */
  bugReportUrl: string;
}

const fromEnv: AppConfig = {
  googleClientId: (env.VITE_GOOGLE_CLIENT_ID as string | undefined)?.trim() || '',
  orgDomain: (env.VITE_ORG_DOMAIN as string | undefined)?.trim().toLowerCase() || '',
  assistantUrl: (env.VITE_ASSISTANT_URL as string | undefined)?.trim() || '',
  notesUrl: '',
  sessionUrl: '',
  bugReportUrl: ''
};

interface ServerConfig {
  googleClientId?: string;
  orgDomain?: string;
  assistant?: boolean;
  notes?: boolean;
  session?: boolean;
  bugReports?: boolean;
}

/**
 * Settings come from the backend (`/api/config` on the Cloudflare Worker) so a
 * deployment is configured without rebuilding. Build-time VITE_* values fill in
 * anything the server leaves empty, and are all there is when running the
 * frontend alone.
 */
export async function loadConfig(): Promise<AppConfig> {
  try {
    const res = await fetch('/api/config', { headers: { Accept: 'application/json' } });
    if (!res.ok || !(res.headers.get('Content-Type') || '').includes('application/json')) return fromEnv;
    const s = (await res.json()) as ServerConfig;
    return {
      googleClientId: s.googleClientId || fromEnv.googleClientId,
      orgDomain: (s.orgDomain || fromEnv.orgDomain).toLowerCase(),
      assistantUrl: s.assistant ? '/api/assistant' : fromEnv.assistantUrl,
      notesUrl: s.notes ? '/api/notes' : '',
      sessionUrl: s.session ? '/api/session' : '',
      bugReportUrl: s.bugReports ? '/api/bug-report' : ''
    };
  } catch {
    return fromEnv;
  }
}
