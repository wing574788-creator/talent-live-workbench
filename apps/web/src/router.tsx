import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { NAV_ITEMS } from '@workbench/shared';
import { AppShell } from './components/AppShell.tsx';
import { CooperationsPage } from './pages/CooperationsPage.tsx';
import { ContactsPage } from './pages/ContactsPage.tsx';
import { HomePage } from './pages/HomePage.tsx';
import { ImportPage } from './pages/ImportPage.tsx';
import { InfluencersPage } from './pages/InfluencersPage.tsx';
import { PlaceholderPage } from './pages/PlaceholderPage.tsx';
import { ProductsPage } from './pages/ProductsPage.tsx';
import { ReviewPage } from './pages/ReviewPage.tsx';
import { SamplesPage } from './pages/SamplesPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';

const rootRoute = createRootRoute({ component: AppShell });

const implemented: Record<string, () => JSX.Element> = {
  '/': HomePage,
  '/cooperations': CooperationsPage,
  '/samples': SamplesPage,
  '/import': ImportPage,
  '/products': ProductsPage,
  '/influencers': InfluencersPage,
  '/contacts': ContactsPage,
  '/review': ReviewPage,
  '/settings': SettingsPage,
};

const routes = NAV_ITEMS.map((item) =>
  createRoute({
    getParentRoute: () => rootRoute,
    path: item.path,
    component: implemented[item.path] ?? (() => <PlaceholderPage title={item.label} />),
  }),
);

export const router = createRouter({ routeTree: rootRoute.addChildren(routes) });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
