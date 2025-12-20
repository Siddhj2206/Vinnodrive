import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { File, Folder, RotateCcw, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { ModeToggle } from "@/components/mode-toggle";
import { StorageInvalidations } from "@/utils/invalidate";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
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

export const Route = createFileRoute("/dashboard/trash")({
  component: TrashView,
  loader: async ({ context }) => {
    // Prefetch trash data before rendering - uses cache if available
    await context.queryClient.ensureQueryData(
      context.trpc.storage.listTrash.queryOptions()
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

function formatDate(date: Date | string | null): string {
  if (!date) return "--";
  return new Date(date).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function TrashView() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  // Query trashed items - use cached data from loader
  const trashQuery = useQuery(trpc.storage.listTrash.queryOptions());

  // Mutations for files
  const restoreFileMutation = useMutation(
    trpc.storage.restoreFromTrash.mutationOptions({
      onSuccess: () => {
        StorageInvalidations.afterRestore(queryClient);
        toast.success("File restored successfully");
      },
      onError: (error) => {
        toast.error(error.message);
      },
    })
  );

  const permanentDeleteFileMutation = useMutation(
    trpc.storage.permanentlyDelete.mutationOptions({
      onSuccess: () => {
        StorageInvalidations.afterPermanentDelete(queryClient);
        toast.success("File permanently deleted");
      },
      onError: (error) => {
        toast.error(error.message);
      },
    })
  );

  // Mutations for folders
  const restoreFolderMutation = useMutation(
    trpc.storage.restoreFolderFromTrash.mutationOptions({
      onSuccess: () => {
        StorageInvalidations.afterRestore(queryClient);
        toast.success("Folder restored successfully");
      },
      onError: (error) => {
        toast.error(error.message);
      },
    })
  );

  const permanentDeleteFolderMutation = useMutation(
    trpc.storage.permanentlyDeleteFolder.mutationOptions({
      onSuccess: () => {
        StorageInvalidations.afterPermanentDelete(queryClient);
        toast.success("Folder permanently deleted");
      },
      onError: (error) => {
        toast.error(error.message);
      },
    })
  );

  const emptyTrashMutation = useMutation(
    trpc.storage.emptyTrash.mutationOptions({
      onSuccess: (data) => {
        StorageInvalidations.afterEmptyTrash(queryClient);
        toast.success(data.message);
      },
      onError: (error) => {
        toast.error(error.message);
      },
    })
  );

  const trashedFiles = trashQuery.data?.files || [];
  const trashedFolders = trashQuery.data?.folders || [];
  const totalItems = trashedFiles.length + trashedFolders.length;

  return (
    <>
      {/* Header */}
      <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="mr-2 h-4" />
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbPage>Trash</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Search className="text-muted-foreground absolute left-2.5 top-2.5 h-4 w-4" />
            <Input
              type="search"
              placeholder="Search trash..."
              className="w-64 pl-8"
            />
          </div>
          <ModeToggle />
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 overflow-auto p-4">
        {/* Toolbar */}
        <div className="mb-4 flex items-center justify-between">
          <p className="text-muted-foreground text-sm">
            {totalItems} item(s) in trash
            {trashedFolders.length > 0 && trashedFiles.length > 0 && (
              <span className="ml-1">
                ({trashedFolders.length} folder(s), {trashedFiles.length} file(s))
              </span>
            )}
          </p>
          {totalItems > 0 && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive">
                  <Trash2 className="mr-2 h-4 w-4" />
                  Empty Trash
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Empty Trash</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will permanently delete all {totalItems} item(s)
                    in trash. This action cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => emptyTrashMutation.mutate()}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    Empty Trash
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>

        {/* Trashed Items List */}
        <div className="rounded-lg border">
          <div className="grid grid-cols-[1fr_100px_120px_100px] gap-4 border-b bg-muted/50 px-4 py-3 text-sm font-medium">
            <div>Name</div>
            <div>Size</div>
            <div>Deleted</div>
            <div>Actions</div>
          </div>

          {/* Trashed Folders */}
          {trashedFolders.map((folder) => (
            <div
              key={folder.id}
              className="grid grid-cols-[1fr_100px_120px_100px] gap-4 border-b px-4 py-3 hover:bg-muted/50"
            >
              <div className="flex items-center gap-3">
                <Folder className="h-5 w-5 text-blue-500 opacity-50" />
                <span className="text-muted-foreground">{folder.name}</span>
              </div>
              <div className="text-muted-foreground text-sm">--</div>
              <div className="text-muted-foreground text-sm">
                {formatDate(folder.deletedAt)}
              </div>
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => restoreFolderMutation.mutate({ id: folder.id })}
                  disabled={restoreFolderMutation.isPending}
                  title="Restore folder"
                >
                  <RotateCcw className="h-4 w-4" />
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="ghost" size="sm" title="Delete permanently">
                      <Trash2 className="text-destructive h-4 w-4" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete Folder Permanently</AlertDialogTitle>
                      <AlertDialogDescription>
                        Are you sure you want to permanently delete "{folder.name}" and all its contents?
                        This action cannot be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() =>
                          permanentDeleteFolderMutation.mutate({ id: folder.id })
                        }
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      >
                        Delete Permanently
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>
          ))}

          {/* Trashed Files */}
          {trashedFiles.map((file) => (
            <div
              key={file.id}
              className="grid grid-cols-[1fr_100px_120px_100px] gap-4 border-b px-4 py-3 hover:bg-muted/50"
            >
              <div className="flex items-center gap-3">
                <File className="text-muted-foreground h-5 w-5" />
                <span className="text-muted-foreground">{file.name}</span>
              </div>
              <div className="text-muted-foreground text-sm">
                {formatBytes(file.size)}
              </div>
              <div className="text-muted-foreground text-sm">
                {formatDate(file.deletedAt)}
              </div>
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => restoreFileMutation.mutate({ id: file.id })}
                  disabled={restoreFileMutation.isPending}
                  title="Restore file"
                >
                  <RotateCcw className="h-4 w-4" />
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="ghost" size="sm" title="Delete permanently">
                      <Trash2 className="text-destructive h-4 w-4" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete Permanently</AlertDialogTitle>
                      <AlertDialogDescription>
                        Are you sure you want to permanently delete "{file.name}"?
                        This action cannot be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() =>
                          permanentDeleteFileMutation.mutate({ id: file.id })
                        }
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      >
                        Delete Permanently
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>
          ))}

          {/* Empty State */}
          {totalItems === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Trash2 className="text-muted-foreground mb-4 h-12 w-12" />
              <h3 className="text-lg font-semibold">Trash is empty</h3>
              <p className="text-muted-foreground">
                Files and folders you delete will appear here
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
