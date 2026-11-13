import { Link } from 'react-router';
import { Icon, MEDIA, useMediaQuery } from '../ui';
import './settings.css';

/**
 * The way back from a page inside Settings › AI (F-026 §7 Agents and AI: "‹ AI"): one place on every one of them, above the page's own title, and
 * 44 px high on touch (#1362). On the phone the header's Back leads to AI, so the page does not carry a second one (#1377).
 */
export function SettingsBack({ to = '/settings/agents', children = 'AI' }: { to?: string; children?: string }) {
  const phone = useMediaQuery(MEDIA.phone);
  if (phone) return null;
  return <Link className="sset-back" to={to} aria-label={`Back to ${children}`}><Icon name="chevron-left" size={12} />{children}</Link>;
}
