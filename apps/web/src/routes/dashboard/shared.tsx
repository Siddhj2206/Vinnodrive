import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Copy, File, Search, Share2 } from "lucide-react";
import { toast } from "sonner";

import { ModeToggle } from "@/components/mode-toggle";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useTRPC } from "@/utils/trpc";

export const Route = createFileRoute("/dashboard/shared")({
  component: SharedView,
  loader: async ({ context }) => {
    // Prefetch files data before rendering - uses cache if available
    await context.queryClient.ensureQueryData(
      context.trpc.storage.listFiles.queryOptions()
    );
  },
});

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function formatDate(date: Date | string): string {
  return new Date(date).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function SharedView() {
  const trpc = useTRPC();

  // Get all files and filter to only shared ones - use cached data from loader
  const filesQuery = useQuery(trpc.storage.listFiles.queryOptions());

  const sharedFiles =
    filesQuery.data?.files.filter((file) => file.isPublic) || [];

  const copyShareLink = (shareId: string | null) => {
    if (!shareId) return;
    const shareUrl = `${window.location.origin}/share/${shareId}`;
    navigator.clipboard.writeText(shareUrl);
    toast.success("Share link copied to clipboard");
  };

  return (
    <>
      {/* Header */}
      <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="mr-2 h-4" />
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbPage>Shared Files</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Search className="text-muted-foreground absolute left-2.5 top-2.5 h-4 w-4" />
            <Input
              type="search"
              placeholder="Search shared..."
              className="w-64 pl-8"
            />
          </div>
          <ModeToggle />
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 overflow-auto p-4">
        {/* Info */}
        <p className="text-muted-foreground mb-4 text-sm">
          {sharedFiles.length} publicly shared file(s)
        </p>

        {/* Shared Files List */}
        <div className="rounded-lg border">
          <div className="grid grid-cols-[1fr_100px_100px_120px_100px] gap-4 border-b bg-muted/50 px-4 py-3 text-sm font-medium">
            <div>Name</div>
            <div>Size</div>
            <div>Downloads</div>
            <div>Shared On</div>
            <div>Actions</div>
          </div>

          {sharedFiles.map((file) => (
            <div
              key={file.id}
              className="grid grid-cols-[1fr_100px_100px_120px_100px] gap-4 border-b px-4 py-3 hover:bg-muted/50"
            >
              <div className="flex items-center gap-3">
                <File className="text-muted-foreground h-5 w-5" />
                <span>{file.name}</span>
                <Share2 className="h-4 w-4 text-green-500" />
              </div>
              <div className="text-muted-foreground text-sm">
                {formatBytes(file.size)}
              </div>
              <div className="text-muted-foreground text-sm">
                {file.downloadCount}
              </div>
              <div className="text-muted-foreground text-sm">
                {formatDate(file.uploadDate)}
              </div>
              <div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => copyShareLink(file.publicShareId)}
                >
                  <Copy className="mr-1 h-4 w-4" />
                  Copy Link
                </Button>
              </div>
            </div>
          ))}

          {/* Empty State */}
          {sharedFiles.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Share2 className="text-muted-foreground mb-4 h-12 w-12" />
              <h3 className="text-lg font-semibold">No shared files</h3>
              <p className="text-muted-foreground">
                Files you share publicly will appear here
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
