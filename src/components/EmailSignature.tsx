import { useMemo } from 'react';
import type { Profile } from '../types';
import { signatureHtml } from '../lib/signature';

/** Renders the exact HTML that goes into outgoing mail. */
export function EmailSignature({ profile }: { profile: Profile }) {
  const html = useMemo(() => signatureHtml(profile), [profile]);
  return <div className="signature" dangerouslySetInnerHTML={{ __html: html }} />;
}
