// Toasts for action results, on Radix's Toast primitive (no runtime-injected styles, so the
// Content Security Policy stays strict).
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { Toast } from 'radix-ui';
import { XIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

type ToastKind = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  description?: string;
}

interface ToastApi {
  notify: (kind: ToastKind, title: string, description?: string) => void;
}

const ToastContext = createContext<ToastApi>({ notify: () => {} });

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const notify = useCallback((kind: ToastKind, title: string, description?: string) => {
    setItems((current) => [
      ...current.slice(-3),
      { id: nextId++, kind, title, ...(description ? { description } : {}) },
    ]);
  }, []);
  const value = useMemo(() => ({ notify }), [notify]);
  const remove = (id: number) => setItems((current) => current.filter((item) => item.id !== id));

  return (
    <ToastContext.Provider value={value}>
      <Toast.Provider swipeDirection="right" duration={5000}>
        {children}
        {items.map((item) => (
          <Toast.Root
            key={item.id}
            onOpenChange={(open) => !open && remove(item.id)}
            className={cn(
              'bg-popover text-popover-foreground relative grid gap-1 rounded-md border p-3 pr-8 shadow-md',
              item.kind === 'error' && 'border-destructive/50',
              item.kind === 'success' && 'border-emerald-600/40',
            )}
          >
            <Toast.Title className="text-sm font-medium">{item.title}</Toast.Title>
            {item.description ? (
              <Toast.Description className="text-muted-foreground text-sm whitespace-pre-line">
                {item.description}
              </Toast.Description>
            ) : null}
            <Toast.Close
              aria-label="Dismiss"
              className="text-muted-foreground hover:text-foreground absolute top-2 right-2"
            >
              <XIcon className="size-4" />
            </Toast.Close>
          </Toast.Root>
        ))}
        <Toast.Viewport className="fixed right-4 bottom-4 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2 outline-none" />
      </Toast.Provider>
    </ToastContext.Provider>
  );
}
