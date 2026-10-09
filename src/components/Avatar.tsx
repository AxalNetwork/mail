import { initials } from '../lib/format';

export function Avatar({ name, photoUrl, accent, size }: { name: string; photoUrl?: string; accent?: boolean; size?: number }) {
  const style = size ? { width: size, height: size } : undefined;
  return (
    <div className={'avatar' + (accent ? ' accent' : '')} style={style} aria-hidden="true">
      {photoUrl ? <img src={photoUrl} alt="" referrerPolicy="no-referrer" /> : initials(name)}
    </div>
  );
}
