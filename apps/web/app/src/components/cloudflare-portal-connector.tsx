"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Cloud, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  cloudflareConnectUrl,
  deployCloudflarePortal,
  getCloudflareConnectorStatus,
  type CloudflareConnectorStatusResult,
} from "@/lib/api/cloudflare";

export function CloudflarePortalConnector({
  domain,
  ready = true,
  verifyActivation,
  onConnected,
  onStatusChange,
}: {
  domain: string;
  ready?: boolean;
  /** Confirms the newly deployed route is serving publicly, not only saved by Cloudflare. */
  verifyActivation?: () => Promise<boolean>;
  onConnected?: () => void;
  onStatusChange?: (status: CloudflareConnectorStatusResult | null) => void;
}): React.ReactElement {
  const [status, setStatus] = useState<CloudflareConnectorStatusResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [deploying, setDeploying] = useState(false);
  const [activationState, setActivationState] = useState<
    "idle" | "checking" | "timed_out"
  >("idle");
  const onConnectedRef = useRef(onConnected);
  const onStatusChangeRef = useRef(onStatusChange);
  const verifyActivationRef = useRef(verifyActivation);
  const activationRunRef = useRef(0);
  const notifiedDeploymentRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const oauthError = new URLSearchParams(window.location.search).get(
      "cloudflare_error",
    );
    if (!oauthError) return null;
    return oauthError === "deployment_failed"
      ? "Cloudflare connected, but the first deployment failed. Try Deploy again."
      : "Cloudflare couldn't be connected. Please try again.";
  });

  useEffect(() => {
    onConnectedRef.current = onConnected;
  }, [onConnected]);

  useEffect(() => {
    onStatusChangeRef.current = onStatusChange;
  }, [onStatusChange]);

  useEffect(() => {
    verifyActivationRef.current = verifyActivation;
  }, [verifyActivation]);

  useEffect(
    () => () => {
      activationRunRef.current += 1;
    },
    [domain],
  );

  useEffect(() => {
    const controller = new AbortController();
    void getCloudflareConnectorStatus(domain, controller.signal).then((next) => {
      if (controller.signal.aborted) return;
      setStatus(next);
      onStatusChangeRef.current?.(next);
      setLoading(false);
    });
    return () => controller.abort();
  }, [domain]);

  const workerConnected =
    status?.connected &&
    status.deployment?.status === "connected";
  const deployed = workerConnected && !status.deployment?.needsDeploy;

  useEffect(() => {
    if (!deployed || !status?.deployment || activationState !== "idle") return;
    const deploymentKey = [
      domain,
      status.deployment.scriptName,
      status.deployment.deployedAt,
    ].join(":");
    if (notifiedDeploymentRef.current === deploymentKey) return;
    notifiedDeploymentRef.current = deploymentKey;
    onConnectedRef.current?.();
  }, [activationState, deployed, domain, status?.deployment]);

  const waitForActivation = async (): Promise<boolean> => {
    const verify = verifyActivationRef.current;
    if (!verify) return true;
    const runId = activationRunRef.current + 1;
    activationRunRef.current = runId;
    // Cloudflare usually activates a new Worker route within a few seconds, but
    // zone propagation can take longer. Keep checking for about half a minute
    // before handing control back to the user.
    const delays = [0, 1_000, 2_000, 3_000, 5_000, 8_000, 10_000];
    for (const delay of delays) {
      if (delay > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
      if (activationRunRef.current !== runId) return false;
      try {
        if (await verify()) return true;
      } catch {
        // A transient verification failure is expected while the route spreads.
      }
    }
    return false;
  };

  const notifyConnected = (
    deployment: NonNullable<CloudflareConnectorStatusResult["deployment"]>,
  ): void => {
    const deploymentKey = [domain, deployment.scriptName, deployment.deployedAt].join(":");
    notifiedDeploymentRef.current = deploymentKey;
    onConnectedRef.current?.();
  };

  const checkActivation = async (
    deployment: NonNullable<CloudflareConnectorStatusResult["deployment"]>,
  ): Promise<void> => {
    setActivationState("checking");
    const active = await waitForActivation();
    if (active) {
      notifyConnected(deployment);
      setActivationState("idle");
      return;
    }
    setActivationState("timed_out");
  };

  const startOAuth = (): void => {
    const current = new URL(window.location.href);
    current.searchParams.delete("cloudflare_error");
    current.searchParams.delete("cloudflare_connected");
    current.searchParams.delete("cloudflare_deployed");
    const returnTo = `${current.pathname}${current.search}${current.hash}`;
    window.location.assign(cloudflareConnectUrl(domain, returnTo));
  };

  const onConnect = async (): Promise<void> => {
    setError(null);
    if (!ready) {
      setError("Wait for the domain to finish saving, then connect Cloudflare.");
      return;
    }
    if (!status?.connected) {
      startOAuth();
      return;
    }
    if (
      activationState === "timed_out" &&
      deployed &&
      status.deployment &&
      verifyActivationRef.current
    ) {
      await checkActivation(status.deployment);
      return;
    }
    setDeploying(true);
    const result = await deployCloudflarePortal(domain);
    setDeploying(false);
    if (!result.ok) {
      if (result.reconnect) {
        startOAuth();
        return;
      }
      setError(result.error);
      return;
    }
    const nextStatus: CloudflareConnectorStatusResult = {
      configured: status.configured,
      connected: true,
      deployment: result.deployment,
    };
    setStatus(nextStatus);
    onStatusChangeRef.current?.(nextStatus);
    if (verifyActivationRef.current && nextStatus.deployment) {
      await checkActivation(nextStatus.deployment);
    }
  };

  const buttonLabel = activationState === "timed_out"
    ? "Check route"
    : !status?.connected
    ? "Connect Cloudflare"
    : deployed
      ? "Redeploy"
      : workerConnected
        ? "Update Worker"
        : "Deploy Worker";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={
            loading ||
            deploying ||
            activationState === "checking" ||
            !ready ||
            status?.configured === false
          }
          onClick={() => void onConnect()}
        >
          {loading || deploying || activationState === "checking" ? (
            <Loader2 className="mr-1 size-3.5 animate-spin" />
          ) : workerConnected ? (
            <RefreshCw className="mr-1 size-3.5" />
          ) : (
            <Cloud className="mr-1 size-3.5" />
          )}
          {deploying
            ? "Deploying…"
            : activationState === "checking"
              ? "Activating routes…"
              : loading
                ? "Checking…"
                : buttonLabel}
        </Button>
        {activationState === "checking" ? (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-700 dark:text-amber-300">
            <Loader2 className="size-3.5 animate-spin" />
            Worker deployed · activating routes
          </span>
        ) : activationState === "timed_out" ? (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-700 dark:text-amber-300">
            <CheckCircle2 className="size-3.5" />
            Worker deployed · activation pending
          </span>
        ) : deployed ? (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="size-3.5" />
            Worker connected
          </span>
        ) : workerConnected ? (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-700 dark:text-amber-300">
            <CheckCircle2 className="size-3.5" />
            Worker connected · update required
          </span>
        ) : status?.connected ? (
          <span className="text-[11px] text-muted-foreground">
            Cloudflare authorized
          </span>
        ) : null}
      </div>
      {!ready ? (
        <p className="text-[10px] text-muted-foreground">
          The connector becomes available after the domain saves automatically.
        </p>
      ) : status?.configured === false ? (
        <p className="text-[10px] text-destructive">
          Cloudflare OAuth is not configured on this deployment.
        </p>
      ) : error || status?.deployment?.lastError ? (
        <p role="alert" className="text-[10px] text-destructive">
          {error ?? status?.deployment?.lastError}
        </p>
      ) : activationState === "timed_out" ? (
        <p className="text-[10px] text-amber-700 dark:text-amber-300">
          Cloudflare is still activating the new routes. Check again shortly.
        </p>
      ) : null}
    </div>
  );
}
