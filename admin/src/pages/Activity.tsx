/**
 * Activity page — wraps ActivityFeed component.
 *
 * Route: /activity
 * Design: issue #184.
 */

import { ActivityFeed } from "../components/ActivityFeed";

export function Activity() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-sm font-semibold text-ink">Live Activity Feed</h1>
        <p className="text-xs text-muted2 mt-1">
          Real-time pipeline events: indicator updates, signals, ratifications, and news enrichment.
        </p>
      </div>
      <ActivityFeed />
    </div>
  );
}
