import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  API_PATHS,
  secretValueProblem,
  slugProblem,
  type SecretDeleteResponse,
  type SecretListResponse,
  type SecretSetResponse,
} from '@mcpier/shared';
import { PlusIcon, TriangleAlertIcon } from 'lucide-react';
import { api, describeError } from '@/lib/api';
import { queryKeys, useSecrets } from '@/lib/queries';
import { EmptyState, ErrorMessage, LoadingRows, PageHeader } from '@/components/common';
import { useToast } from '@/components/toaster';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

type Secret = SecretListResponse['secrets'][number];

/** Set a new secret or replace a value. The value is sent once and the field cleared. */
function SetSecretDialog({
  open,
  onOpenChange,
  name: fixedName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name?: string;
}) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const client = useQueryClient();
  const { notify } = useToast();
  const effectiveName = fixedName ?? name;
  const set = useMutation({
    mutationFn: () => api.put<SecretSetResponse>(API_PATHS.secret(effectiveName), { value }),
    onSuccess: (response) => {
      setValue('');
      setName('');
      void client.invalidateQueries({ queryKey: queryKeys.secrets });
      notify(
        'success',
        `Saved the secret ${response.name}.`,
        response.restarted.length > 0 ? `Restarted ${response.restarted.join(', ')} to use it.` : undefined,
      );
      onOpenChange(false);
    },
    onError: () => setValue(''),
  });
  const nameProblem = fixedName || !name ? undefined : slugProblem(name);
  const valueProblem = value ? secretValueProblem(value) : undefined;
  const close = (next: boolean) => {
    if (!next) {
      setValue('');
      set.reset();
    }
    onOpenChange(next);
  };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{fixedName ? `Replace ${fixedName}` : 'New secret'}</DialogTitle>
          <DialogDescription>
            Stored in Windows Credential Manager. MCPier never shows the value again; servers that use it
            restart.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (effectiveName && value && !nameProblem && !valueProblem) set.mutate();
          }}
        >
          {fixedName ? null : (
            <div className="space-y-1.5">
              <Label htmlFor="secret-name">Name</Label>
              <Input
                id="secret-name"
                value={name}
                aria-invalid={nameProblem !== undefined}
                onChange={(event) => setName(event.target.value)}
              />
              {nameProblem ? (
                <p className="text-destructive text-xs">Name {nameProblem}.</p>
              ) : (
                <p className="text-muted-foreground text-xs">
                  Referenced in config as secret:{name || '<name>'}
                </p>
              )}
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="secret-value">Value</Label>
            <Input
              id="secret-value"
              type="password"
              autoComplete="off"
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
            {valueProblem ? <p className="text-destructive text-xs">The value {valueProblem}.</p> : null}
          </div>
          {set.error ? <ErrorMessage error={set.error} title="Could not save the secret" /> : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!effectiveName || !value || set.isPending || !!nameProblem || !!valueProblem}
            >
              Save secret
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Delete with confirmation; a referenced secret needs an explicit "delete anyway". */
function DeleteSecretDialog({ secret, onClose }: { secret: Secret | undefined; onClose: () => void }) {
  const [force, setForce] = useState(false);
  const client = useQueryClient();
  const { notify } = useToast();
  const used = (secret?.usedBy.length ?? 0) > 0;
  const remove = useMutation({
    mutationFn: () =>
      api.delete<SecretDeleteResponse>(`${API_PATHS.secret(secret!.name)}${used ? '?force=true' : ''}`),
    onSuccess: (response) => {
      void client.invalidateQueries({ queryKey: queryKeys.secrets });
      notify(
        'success',
        `Deleted the secret ${response.name}.`,
        response.restarted.length > 0
          ? `Restarted ${response.restarted.join(', ')}; they now report a missing secret.`
          : undefined,
      );
      setForce(false);
      onClose();
    },
    onError: (error) => notify('error', `Could not delete ${secret?.name}`, describeError(error).message),
  });
  return (
    <Dialog
      open={secret !== undefined}
      onOpenChange={(open) => {
        if (!open) {
          setForce(false);
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {secret?.name}?</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2">
              <p>The value is removed from Credential Manager. This cannot be undone.</p>
              {used ? (
                <p className="text-destructive">
                  Used by {secret!.usedBy.join(', ')}.{' '}
                  {secret!.usedBy.length === 1 ? 'That server' : 'Those servers'} will stop with a
                  missing-secret error.
                </p>
              ) : null}
            </div>
          </DialogDescription>
        </DialogHeader>
        {used ? (
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={force}
              onCheckedChange={(checked) => setForce(checked === true)}
              aria-label="Delete it anyway"
            />
            Delete it anyway
          </label>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={(used && !force) || remove.isPending}
            onClick={() => remove.mutate()}
          >
            Delete {secret?.name}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function SecretsPage() {
  const secrets = useSecrets();
  const [creating, setCreating] = useState(false);
  const [replacing, setReplacing] = useState<string | undefined>();
  const [deleting, setDeleting] = useState<Secret | undefined>();
  const newButton = (
    <Button onClick={() => setCreating(true)}>
      <PlusIcon aria-hidden="true" />
      New secret
    </Button>
  );

  return (
    <>
      <PageHeader
        title="Secrets"
        description="Values kept in Windows Credential Manager. Config refers to them as secret:<name>; the values never leave MCPier."
        actions={newButton}
      />
      {secrets.isPending ? (
        <LoadingRows label="Loading secrets" />
      ) : secrets.error ? (
        <ErrorMessage error={secrets.error} title="Cannot load the secrets" />
      ) : (
        <div className="space-y-6">
          {secrets.data.missing.length > 0 ? (
            <div role="alert" className="border-destructive/40 space-y-1 rounded-md border p-3 text-sm">
              <p className="flex items-center gap-2 font-medium">
                <TriangleAlertIcon className="text-destructive size-4" aria-hidden="true" />
                Referenced but not set
              </p>
              <ul className="space-y-1">
                {secrets.data.missing.map((missing) => (
                  <li
                    key={missing.name}
                    className="flex flex-wrap items-center gap-2"
                    data-missing={missing.name}
                  >
                    <span className="font-mono">{missing.name}</span>
                    <span className="text-muted-foreground">used by {missing.usedBy.join(', ')}</span>
                    <Button size="sm" variant="outline" onClick={() => setReplacing(missing.name)}>
                      Set it
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {secrets.data.secrets.length === 0 ? (
            <EmptyState title="No secrets yet" action={newButton}>
              Add one here, or from a terminal with{' '}
              <code className="font-mono">mcpier secret set &lt;name&gt;</code>.
            </EmptyState>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Ends with</TableHead>
                    <TableHead>Used by</TableHead>
                    <TableHead className="w-48">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {secrets.data.secrets.map((secret) => (
                    <TableRow key={secret.name} data-secret={secret.name}>
                      <TableCell className="font-mono text-sm">{secret.name}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {secret.last4 ? `…${secret.last4}` : '—'}
                      </TableCell>
                      <TableCell className="text-sm">
                        {secret.usedBy.length > 0 ? (
                          secret.usedBy.join(', ')
                        ) : (
                          <span className="text-muted-foreground">nothing</span>
                        )}
                      </TableCell>
                      <TableCell className="space-x-2 text-right">
                        <Button size="sm" variant="outline" onClick={() => setReplacing(secret.name)}>
                          Replace
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setDeleting(secret)}>
                          Delete
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      )}
      <SetSecretDialog open={creating} onOpenChange={setCreating} />
      <SetSecretDialog
        key={replacing}
        open={replacing !== undefined}
        onOpenChange={(open) => !open && setReplacing(undefined)}
        name={replacing}
      />
      <DeleteSecretDialog secret={deleting} onClose={() => setDeleting(undefined)} />
    </>
  );
}
