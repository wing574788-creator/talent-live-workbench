import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { MotionConfig } from 'motion/react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { ToastProvider } from './components/ui.tsx';
import { router } from './router.tsx';

const queryClient = new QueryClient();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <MotionConfig reducedMotion="user">
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </MotionConfig>
    </QueryClientProvider>
  </StrictMode>,
);
