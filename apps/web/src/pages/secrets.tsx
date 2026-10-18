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
import { LockIcon, PlusIcon, Trash2Icon, TriangleAlertIcon } from 'lucide-react';
import { api, describeError } from '@/lib/api';
import { queryKeys, useSecrets, useServers } from '@/lib/queries';
import { EmptyState, ErrorMessage, LoadingRows } from '@/components/common';
import { PageTitle, Panel, PanelBody, PanelHeader, RailGrid, Stack } from '@/components/kit';
import { ServerTile } from '@/components/server-tile';
import { SecretChip, ToneBadge } from '@/components/status-badge';
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
                <p className="text-tone-bad-text text-xs">Name {nameProblem}.</p>
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
            {valueProblem ? <p className="text-tone-bad-text text-xs">The value {valueProblem}.</p> : null}
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
                <p className="text-tone-bad-text">
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
  const servers = useServers();
  const [creating, setCreating] = useState(false);
  const [replacing, setReplacing] = useState<string | undefined>();
  const [deleting, setDeleting] = useState<Secret | undefined>();
  const iconOf = (name: string) => servers.data?.servers.find((server) => server.name === name)?.icon;
  const newButton = (
    <Button onClick={() => setCreating(true)}>
      <PlusIcon aria-hidden="true" />
      New secret
    </Button>
  );
  const usedBy = (names: string[]) =>
    names.length === 0 ? (
      <span className="text-faint">nothing</span>
    ) : (
      <span className="flex flex-wrap gap-x-3 gap-y-1">
        {names.map((name) => (
          <span key={name} className="inline-flex items-center gap-1.5">
            <ServerTile name={name} icon={iconOf(name)} size="sm" />
            {name}
          </span>
        ))}
      </span>
    );

  return (
    <>
      <PageTitle
        title="Secrets"
        info="Values kept in Windows Credential Manager. Config refers to them as secret:<name>; the values never leave MCPier."
        meta={
          <span className="text-faint flex items-center gap-1.5 text-xs">
            <LockIcon aria-hidden="true" className="size-3.5" />
            Windows Credential Manager
          </span>
        }
        actions={newButton}
      />
      {secrets.isPending ? (
        <LoadingRows label="Loading secrets" />
      ) : secrets.error ? (
        <ErrorMessage error={secrets.error} title="Cannot load the secrets" />
      ) : (
        <RailGrid>
          <Stack>
            {secrets.data.missing.length > 0 ? (
              <div
                role="alert"
                className="border-tone-warn/35 bg-tone-warn-soft text-tone-warn-text rounded-[10px] border px-3.5 py-2.5 text-sm"
              >
                <p className="m-0 flex items-center gap-2 font-semibold">
                  <TriangleAlertIcon className="size-4" aria-hidden="true" />
                  <span>Referenced but not set</span>
                </p>
                <ul className="m-0 mt-1 list-none space-y-0.5 p-0 pl-6">
                  {secrets.data.missing.map((missing) => (
                    <li key={missing.name}>
                      <span className="font-mono">{missing.name}</span>, used by {missing.usedBy.join(', ')}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {secrets.data.secrets.length === 0 && secrets.data.missing.length === 0 ? (
              <EmptyState title="No secrets yet" action={newButton}>
                Store API keys and tokens here, then refer to them in a server as secret:&lt;name&gt;.
              </EmptyState>
            ) : (
              <Panel className="overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Value</TableHead>
                      <TableHead>Used by</TableHead>
                      <TableHead className="w-48">
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {secrets.data.missing.map((missing) => (
                      <TableRow key={missing.name} data-missing={missing.name} className="edge-warn">
                        <TableCell>
                          <SecretChip name={missing.name} missing />
                        </TableCell>
                        <TableCell>
                          <ToneBadge tone="warn">Missing</ToneBadge>
                        </TableCell>
                        <TableCell className="text-sm whitespace-normal">
                          <span className="text-faint">referenced by {missing.usedBy.join(', ')}</span>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button size="sm" onClick={() => setReplacing(missing.name)}>
                            Set it
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                    {secrets.data.secrets.map((secret) => (
                      <TableRow key={secret.name} data-secret={secret.name}>
                        <TableCell>
                          <SecretChip name={secret.name} />
                          <span className="sr-only">{secret.name}</span>
                        </TableCell>
                        <TableCell className="text-muted-foreground font-mono text-xs">
                          {secret.last4 ? `••••${secret.last4}` : '••••'}
                        </TableCell>
                        <TableCell className="text-sm whitespace-normal">{usedBy(secret.usedBy)}</TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1.5">
                            <Button size="sm" variant="outline" onClick={() => setReplacing(secret.name)}>
                              Replace
                            </Button>
                            <Button size="sm" variant="destructive-ghost" onClick={() => setDeleting(secret)}>
                              <Trash2Icon aria-hidden="true" />
                              Delete
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Panel>
            )}
          </Stack>
          <Panel aria-label="How secrets work">
            <PanelHeader title="How secrets work" />
            <PanelBody className="text-muted-foreground space-y-2 text-sm">
              <p className="m-0">
                Reference one in a server's env or header as <SecretChip name="name" />.
              </p>
              <p className="m-0">Values are resolved in memory and redacted from results and logs.</p>
              <p className="m-0">
                From a terminal: <code className="font-mono text-xs">mcpier secret set &lt;name&gt;</code>
              </p>
            </PanelBody>
          </Panel>
        </RailGrid>
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
