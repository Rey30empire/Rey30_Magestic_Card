import { get } from "../db/sqlite";

type SandboxRow = {
  id: string;
  status: string;
  created_at: string;
};

export type SandboxGateResult =
  | {
      ok: true;
      latestTestId: string;
      testedAt: string;
      ageMinutes: number;
    }
  | {
      ok: false;
      reason: "missing" | "failed" | "stale";
      latestTestId: string | null;
      testedAt: string | null;
      ageMinutes: number | null;
    };

export async function checkAgentSandboxGate(agentId: string, maxAgeMinutes = 24 * 60): Promise<SandboxGateResult> {
  const latest = await get<SandboxRow>(
    `
      SELECT id, status, created_at
      FROM agent_sandbox_tests
      WHERE agent_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [agentId]
  );

  if (!latest) {
    return {
      ok: false,
      reason: "missing",
      latestTestId: null,
      testedAt: null,
      ageMinutes: null
    };
  }

  const testedAtMs = new Date(latest.created_at).getTime();
  const ageMinutes = Math.max(0, Math.floor((Date.now() - testedAtMs) / 60_000));

  if (latest.status !== "passed") {
    return {
      ok: false,
      reason: "failed",
      latestTestId: latest.id,
      testedAt: latest.created_at,
      ageMinutes
    };
  }

  if (ageMinutes > maxAgeMinutes) {
    return {
      ok: false,
      reason: "stale",
      latestTestId: latest.id,
      testedAt: latest.created_at,
      ageMinutes
    };
  }

  return {
    ok: true,
    latestTestId: latest.id,
    testedAt: latest.created_at,
    ageMinutes
  };
}
