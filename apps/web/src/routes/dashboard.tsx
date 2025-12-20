import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

import { AppSidebar } from "@/components/dashboard/app-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { authClient } from "@/lib/auth-client";
import { useTRPC } from "@/utils/trpc";

export const Route = createFileRoute("/dashboard")({
  component: DashboardLayout,
  beforeLoad: async ({ context }) => {
    // Use cached session from auth client instead of server function
    const { data: session } = await authClient.getSession();
    if (!session) {
      throw redirect({ to: "/login" });
    }
    
    // Prefetch sidebar data (quota and folders) - uses cache if available
    await Promise.all([
      context.queryClient.ensureQueryData(context.trpc.storage.getQuota.queryOptions()),
      context.queryClient.ensureQueryData(context.trpc.storage.listFolders.queryOptions()),
    ]);
    
    return { session };
  },
});

function DashboardLayout() {
  const { session } = Route.useRouteContext();
  const trpc = useTRPC();

  // Fetch quota data for storage card - use cached data from beforeLoad
  const quotaQuery = useQuery(trpc.storage.getQuota.queryOptions());

  // Fetch folders for sidebar navigation - use cached data from beforeLoad
  const foldersQuery = useQuery(trpc.storage.listFolders.queryOptions());

  const user = {
    name: session?.user.name || "User",
    email: session?.user.email || "",
    avatar: session?.user.image || undefined,
  };

  return (
    <SidebarProvider>
      <AppSidebar
        user={user}
        folders={foldersQuery.data || []}
        storageUsed={quotaQuery.data?.storageUsed || 0}
        storageLimit={quotaQuery.data?.storageLimit || 1073741824}
      />
      <SidebarInset>
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  );
}
