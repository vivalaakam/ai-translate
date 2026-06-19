import { useState, useEffect, useCallback } from 'react';

export type Route =
  | { view: 'library' }
  | { view: 'jobs' }
  | { view: 'detail'; bookId: string };

/**
 * Parse location.hash into a Route.
 *
 * Routes:
 *   #/            → library
 *   #/jobs        → jobs
 *   #/book/:id    → detail (book detail)
 *   anything else → library
 */
function parseHash(): Route {
  const hash = window.location.hash.replace(/^#/, '');
  const parts = hash.split('/').filter(Boolean); // ['book', 'id'] or ['jobs'] or []

  if (parts.length === 0) return { view: 'library' };
  if (parts[0] === 'jobs') return { view: 'jobs' };
  if (parts[0] === 'book' && parts[1]) return { view: 'detail', bookId: parts[1] };
  return { view: 'library' };
}

/**
 * Convert a Route to a hash string for location.hash.
 */
function routeToHash(route: Route): string {
  switch (route.view) {
    case 'library': return '#/';
    case 'jobs': return '#/jobs';
    case 'detail': return `#/book/${route.bookId}`;
  }
}

/**
 * Hash-based router hook. Returns the current route and a navigate function.
 *
 * On mount, reads the current hash. Listens to 'hashchange' so the route
 * stays in sync when the user navigates with back/forward buttons.
 *
 * navigate() sets location.hash, which triggers hashchange → state update.
 */
export function useHashRoute(): { route: Route; navigate: (route: Route) => void } {
  const [route, setRoute] = useState<Route>(() => parseHash());

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const navigate = useCallback((newRoute: Route) => {
    const hash = routeToHash(newRoute);
    if (window.location.hash !== hash) {
      window.location.hash = hash;
    }
    // Also update immediately in case hashchange hasn't fired yet
    setRoute(newRoute);
  }, []);

  return { route, navigate };
}