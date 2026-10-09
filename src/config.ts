const env = import.meta.env;

export const config = {
  googleClientId: (env.VITE_GOOGLE_CLIENT_ID as string | undefined)?.trim() || '',
  orgDomain: (env.VITE_ORG_DOMAIN as string | undefined)?.trim().toLowerCase() || '',
  assistantUrl: (env.VITE_ASSISTANT_URL as string | undefined)?.trim() || ''
};

export const gmailConfigured = !!config.googleClientId;
