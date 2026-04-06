import { prisma } from "./database.js";
import { dispatchAction } from "./action-dispatcher.js";
import { getConnectedMachineIds } from "../websocket/sessions.js";
import { broadcastToDashboard } from "../websocket/dashboard.js";

/**
 * Resolve machines matching a profile's tagFilters.
 * If tagFilters is empty, returns all ONLINE machines.
 * Otherwise, returns machines that have ALL specified tags AND are ONLINE.
 */
export async function resolveProfileMachines(
  profile: { tagFilters: string[] }
): Promise<{ id: string; hostname: string | null }[]> {
  const onlineIds = getConnectedMachineIds();

  if (onlineIds.length === 0) return [];

  if (profile.tagFilters.length === 0) {
    // Return all online machines
    const machines = await prisma.machine.findMany({
      where: { id: { in: onlineIds } },
      select: { id: true, hostname: true },
    });
    return machines;
  }

  // Find machines that have ALL the required tags and are online
  const machines = await prisma.machine.findMany({
    where: {
      id: { in: onlineIds },
      AND: profile.tagFilters.map((tagName) => ({
        tags: {
          some: {
            tag: { name: tagName },
          },
        },
      })),
    },
    select: { id: true, hostname: true },
  });

  return machines;
}

/**
 * Execute a profile: resolve machines, create executions, dispatch actions.
 */
export async function executeProfile(
  profileId: string
): Promise<{
  success: boolean;
  error?: string;
  totalMachines?: number;
  dispatched?: number;
  skipped?: number;
  failed?: number;
}> {
  // Load profile
  const profile = await prisma.profile.findUnique({
    where: { id: profileId },
  });

  if (!profile) {
    return { success: false, error: "Profile not found" };
  }

  if (!profile.enabled) {
    return { success: false, error: "Profile is disabled" };
  }

  // Resolve target machines
  const machines = await resolveProfileMachines(profile);

  if (machines.length === 0) {
    return { success: true, totalMachines: 0, dispatched: 0, skipped: 0, failed: 0 };
  }

  const config = profile.config as Record<string, any>;
  const deliveryWindowMs = config.deliveryWindowMinutes
    ? config.deliveryWindowMinutes * 60 * 1000
    : 0;

  let dispatched = 0;
  let skipped = 0;
  let failed = 0;

  for (const machine of machines) {
    // Create execution record
    const execution = await prisma.profileExecution.create({
      data: {
        profileId: profile.id,
        machineId: machine.id,
        status: "PENDING",
      },
    });

    // Determine action based on profile type
    let actionId: string | null = null;
    let params: Record<string, any> = {};
    let skipReason: string | null = null;

    switch (profile.type) {
      case "UPGRADE":
        actionId = config.securityOnly
          ? "system.update_security"
          : "system.update";
        break;

      case "REBOOT":
        skipReason = "reboot action not yet implemented";
        break;

      case "SCRIPT":
        actionId = "script.execute";
        params = {
          script: config.script,
          timeout: config.timeoutSeconds,
        };
        break;

      case "PACKAGE":
        actionId =
          config.action === "remove" ? "package.remove" : "package.install";
        params = { packages: config.packages };
        break;
    }

    // Handle skipped actions
    if (skipReason) {
      await prisma.profileExecution.update({
        where: { id: execution.id },
        data: {
          status: "SKIPPED",
          output: { reason: skipReason } as any,
          completedAt: new Date(),
        },
      });
      skipped++;

      broadcastToDashboard({
        type: "profile.execution.skipped",
        data: {
          profileId: profile.id,
          profileName: profile.name,
          executionId: execution.id,
          machineId: machine.id,
          hostname: machine.hostname,
          reason: skipReason,
        },
      });
      continue;
    }

    // Apply staggered delivery delay
    const delay = deliveryWindowMs
      ? Math.floor(Math.random() * deliveryWindowMs)
      : 0;

    const doDispatch = async () => {
      try {
        const result = await dispatchAction(
          machine.id,
          { action_id: actionId!, params },
          profile.createdBy ?? undefined
        );

        if (result.success) {
          await prisma.profileExecution.update({
            where: { id: execution.id },
            data: {
              status: "RUNNING",
              output: { requestId: result.requestId } as any,
            },
          });
          dispatched++;

          broadcastToDashboard({
            type: "profile.execution.dispatched",
            data: {
              profileId: profile.id,
              profileName: profile.name,
              executionId: execution.id,
              machineId: machine.id,
              hostname: machine.hostname,
              actionId,
              requestId: result.requestId,
            },
          });
        } else {
          await prisma.profileExecution.update({
            where: { id: execution.id },
            data: {
              status: "FAILED",
              output: { error: result.error } as any,
              completedAt: new Date(),
            },
          });
          failed++;

          broadcastToDashboard({
            type: "profile.execution.failed",
            data: {
              profileId: profile.id,
              profileName: profile.name,
              executionId: execution.id,
              machineId: machine.id,
              hostname: machine.hostname,
              error: result.error,
            },
          });
        }
      } catch (err: any) {
        await prisma.profileExecution.update({
          where: { id: execution.id },
          data: {
            status: "FAILED",
            output: { error: err.message } as any,
            completedAt: new Date(),
          },
        });
        failed++;
      }
    };

    if (delay > 0) {
      setTimeout(doDispatch, delay);
    } else {
      await doDispatch();
    }
  }

  broadcastToDashboard({
    type: "profile.execution.summary",
    data: {
      profileId: profile.id,
      profileName: profile.name,
      totalMachines: machines.length,
      dispatched,
      skipped,
      failed,
    },
  });

  return {
    success: true,
    totalMachines: machines.length,
    dispatched,
    skipped,
    failed,
  };
}

/**
 * Initialize profile scheduler.
 * For now, only manual triggering is supported via the API.
 */
export function initProfileScheduler(): void {
  console.log(
    "[Profiles] Scheduler initialized (manual trigger only for now)"
  );
}
