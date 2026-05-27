// Lightweight tests for the `initTelemetry` no-op path.
//
// We can't easily test the SDK-up path without actually starting an
// OTLP collector — that's covered by integration smoke (the
// `bootstrap` paths log `telemetry.started` on real boot). What we
// CAN guarantee here:
//
//   - When config.enabled === false, the returned handle is a true
//     no-op and `shutdown()` resolves immediately.
//   - The diagnostic callback fires with the expected event names.

import { describe, expect, it, vi } from "vitest";

import { initTelemetry } from "./init-telemetry.js";

describe("initTelemetry — disabled", () => {
  it("returns a no-op handle when config.enabled is false", async () => {
    const onBootDiagnostic = vi.fn();
    const handle = await initTelemetry({
      config: {
        enabled: false,
        serviceName: "pharmacy-web",
        serviceVersion: null,
        deploymentEnvironment: "development",
        endpoint: "http://localhost:4318",
        headers: {},
        tracesSamplerRatio: 1.0,
      },
      onBootDiagnostic,
    });

    expect(handle.enabled).toBe(false);
    expect(handle.serviceName).toBe("pharmacy-web");
    await expect(handle.shutdown()).resolves.toBeUndefined();
    expect(onBootDiagnostic).toHaveBeenCalledWith(
      "info",
      "telemetry.disabled",
      expect.objectContaining({ serviceName: "pharmacy-web" })
    );
  });
});
