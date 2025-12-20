import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

import { AppSidebar } from "@/components/dashboard/app-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { getUser } from "@/functions/get-user";
import { useTRPC } from "@/utils/trpc";

export const Route = createFileRoute("/dashboard")({
  component: DashboardLayout,
  beforeLoad: async () => {
    const session = await getUser();
    return { session };
  },
  loader: async ({ context }) => {
    if (!context.session) {
      throw redirect({
        to: "/login",
      });
    }
  },
});

function DashboardLayout() {
  const { session } = Route.useRouteContext();
  const trpc = useTRPC();

  // Fetch quota data for storage card
  const quotaQuery = useQuery(trpc.storage.getQuota.queryOptions());

  // Fetch folders for sidebar navigation
  const filesQuery = useQuery(trpc.storage.listFiles.queryOptions());

  const user = {
    name: session?.user.name || "User",
    email: session?.user.email || "",
    avatar: session?.user.image || undefined,
  };

  return (
    <SidebarProvider>
      <AppSidebar
        user={user}
        folders={filesQuery.data?.folders || []}
        storageUsed={quotaQuery.data?.storageUsed || 0}
        storageLimit={quotaQuery.data?.storageLimit || 1073741824}
      />
      <SidebarInset>
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  );
}
