import * as React from 'react';
import { ChevronDownIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * A native <select> styled like the other form controls. It replaces Radix Select, whose
 * list injects a <style> element at run time that the dashboard's CSP blocks (Sprint 5
 * BUGS B-4). Options are plain <option> children; the browser draws the list.
 */
function NativeSelect({
  className,
  wrapperClassName,
  controlSize = 'default',
  ...props
}: React.ComponentProps<'select'> & { controlSize?: 'sm' | 'default'; wrapperClassName?: string }) {
  return (
    <div className={cn('relative w-fit', wrapperClassName)} data-slot="native-select-wrapper">
      <select
        data-slot="native-select"
        data-size={controlSize}
        className={cn(
          'w-full appearance-none rounded-md border border-input bg-panel-2 py-2 pr-8 pl-3 text-sm shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 data-[size=default]:h-9 data-[size=sm]:h-8 data-[size=sm]:py-1 dark:aria-invalid:ring-destructive/40 [&>option]:bg-popover [&>option]:text-popover-foreground',
          className,
        )}
        {...props}
      />
      <ChevronDownIcon
        aria-hidden="true"
        className="text-muted-foreground pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 opacity-50"
      />
    </div>
  );
}

export { NativeSelect };
