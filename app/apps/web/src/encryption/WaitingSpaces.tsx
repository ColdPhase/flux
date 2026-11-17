import { Link } from 'react-router';
import { useShellData } from '../app/data';
import { Icon } from '../ui';
import { lockedLine, useLockedWorkspaces } from './state';
import './waiting.css';

// What the shell says about spaces that wait to be unlocked without the locked panel itself (F-030, #655): Home's rows and Search's line. The
// panel (`LockedSpace`) and its form are not part of the first visit's code: they come when a locked place is opened (#1178).

/**
 * Home's "Needs you" (F-030, #655): what needs the person in a space that waits to be unlocked is not known until it is unlocked, so the
 * queue says which spaces it could not look into, one quiet row each, instead of "Nothing needs you".
 */
export function WaitingSpaces() {
  const locked = useLockedWorkspaces();
  if (!locked.length) return null;
  return (
    // Home's rows, in a card of their own (visual review 2026-11-17, core 14): the lock tile, the name, the state and the arrow, never a
    // stray line between two cards.
    <ul className="home__rows waiting-spaces" aria-label="Waiting to be unlocked" data-waiting-spaces="">
      {locked.map((space) => (
        <li key={space.id}>
          <Link className="home__row" to={`/spaces/${space.id}`} data-locked-space={space.id}>
            <span className="nyc__face nyc__face--icon"><Icon name="lock" size={16} /></span>
            <span className="home__row-b">
              <span className="home__row-t waiting-spaces__name">{space.name}</span>
              <span className="home__row-k waiting-spaces__state">{lockedLine(space)}</span>
            </span>
            <Icon name="chevron-right" size={16} className="home__row-go" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * Search's line about an encrypted space the server cannot search in memory because it is too large (`sealedUnavailable`, F-030, #655). One
 * that waits to be unlocked is not named here: the sidebar and Home say it waits, and Search says nothing (#1419 item 16).
 */
export function UnsearchedSpaces({ tooLarge }: { tooLarge: readonly string[] }) {
  const { workspaces } = useShellData();
  const large = tooLarge.map((id) => workspaces.find((space) => space.id === id)).filter((space): space is NonNullable<typeof space> => !!space);
  if (!large.length) return null;
  return (
    <ul className="unsearched" aria-label="Not searched" data-unsearched="">
      {large.map((space) => (
        <li key={space.id} data-too-large={space.id}><Icon name="lock" size={13} />
          <span>Search isn’t available in {space.name}: it is too large to search in memory.</span></li>
      ))}
    </ul>
  );
}
