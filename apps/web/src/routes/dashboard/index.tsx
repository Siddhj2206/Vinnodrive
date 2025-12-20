import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  Copy,
  File,
  Folder,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Search,
  Share2,
  Trash2,
  Upload,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { FileUpload } from "@/components/dashboard/file-upload";
import { ModeToggle } from "@/components/mode-toggle";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Switch } from "@/components/ui/switch";
import { useTRPC } from "@/utils/trpc";

export const Route = createFileRoute("/dashboard/")({
  component: DashboardIndex,
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

function DashboardIndex() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  // State for dialogs
  const [createFolderOpen, setCreateFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renameItem, setRenameItem] = useState<{
    id: string;
    name: string;
    type: "file" | "folder";
  } | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteItem, setDeleteItem] = useState<{
    id: string;
    name: string;
    type: "file" | "folder";
  } | null>(null);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [shareItem, setShareItem] = useState<{
    id: string;
    name: string;
    isPublic: boolean;
    publicShareId: string | null;
  } | null>(null);
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);

  // Queries
  const filesQuery = useQuery(trpc.storage.listFiles.queryOptions());
  const statsQuery = useQuery(trpc.storage.getStats.queryOptions());

  // Mutations
  const createFolderMutation = useMutation(
    trpc.storage.createFolder.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["storage", "listFiles"] });
        setCreateFolderOpen(false);
        setNewFolderName("");
        toast.success("Folder created successfully");
      },
      onError: (error) => {
        toast.error(error.message);
      },
    })
  );

  const renameFolderMutation = useMutation(
    trpc.storage.renameFolder.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["storage", "listFiles"] });
        setRenameDialogOpen(false);
        setRenameItem(null);
        toast.success("Folder renamed successfully");
      },
      onError: (error) => {
        toast.error(error.message);
      },
    })
  );

  const renameFileMutation = useMutation(
    trpc.storage.renameFile.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["storage", "listFiles"] });
        setRenameDialogOpen(false);
        setRenameItem(null);
        toast.success("File renamed successfully");
      },
      onError: (error) => {
        toast.error(error.message);
      },
    })
  );

  const deleteFolderMutation = useMutation(
    trpc.storage.deleteFolder.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["storage", "listFiles"] });
        setDeleteDialogOpen(false);
        setDeleteItem(null);
        toast.success("Folder deleted successfully");
      },
      onError: (error) => {
        toast.error(error.message);
      },
    })
  );

  const moveToTrashMutation = useMutation(
    trpc.storage.moveToTrash.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["storage", "listFiles"] });
        queryClient.invalidateQueries({ queryKey: ["storage", "getStats"] });
        setDeleteDialogOpen(false);
        setDeleteItem(null);
        toast.success("File moved to trash");
      },
      onError: (error) => {
        toast.error(error.message);
      },
    })
  );

  const togglePublicMutation = useMutation(
    trpc.storage.togglePublic.mutationOptions({
      onSuccess: (data) => {
        queryClient.invalidateQueries({ queryKey: ["storage", "listFiles"] });
        if (data.isPublic) {
          toast.success("File is now public");
        } else {
          toast.success("File is now private");
        }
      },
      onError: (error) => {
        toast.error(error.message);
      },
    })
  );

  const handleCreateFolder = () => {
    if (!newFolderName.trim()) return;
    createFolderMutation.mutate({ name: newFolderName.trim() });
  };

  const handleRename = () => {
    if (!renameItem || !renameItem.name.trim()) return;
    if (renameItem.type === "folder") {
      renameFolderMutation.mutate({ id: renameItem.id, name: renameItem.name.trim() });
    } else {
      renameFileMutation.mutate({ id: renameItem.id, name: renameItem.name.trim() });
    }
  };

  const handleDelete = () => {
    if (!deleteItem) return;
    if (deleteItem.type === "folder") {
      deleteFolderMutation.mutate({ id: deleteItem.id });
    } else {
      moveToTrashMutation.mutate({ id: deleteItem.id });
    }
  };

  const handleTogglePublic = (isPublic: boolean) => {
    if (!shareItem) return;
    togglePublicMutation.mutate({ id: shareItem.id, isPublic });
    setShareItem({ ...shareItem, isPublic });
  };

  const copyShareLink = () => {
    if (!shareItem?.publicShareId) return;
    const shareUrl = `${window.location.origin}/share/${shareItem.publicShareId}`;
    navigator.clipboard.writeText(shareUrl);
    toast.success("Share link copied to clipboard");
  };

  const stats = statsQuery.data;
  const files = filesQuery.data?.files || [];
  const folders = filesQuery.data?.folders || [];

  return (
    <>
      {/* Header */}
      <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="mr-2 h-4" />
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbPage>All Files</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Search className="text-muted-foreground absolute left-2.5 top-2.5 h-4 w-4" />
            <Input
              type="search"
              placeholder="Search files..."
              className="w-64 pl-8"
            />
          </div>
          <ModeToggle />
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 overflow-auto p-4">
        {/* Stats Cards */}
        <div className="mb-6 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Storage Used</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {stats?.storageUsedFormatted || "0 B"}
              </div>
              <p className="text-muted-foreground text-xs">
                {stats?.usagePercent?.toFixed(1) || 0}% of {stats?.storageLimitFormatted || "1 GB"}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Files</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats?.totalFiles || 0}</div>
              <p className="text-muted-foreground text-xs">
                {stats?.dedupedFiles || 0} deduplicated
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Space Saved</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {stats?.savedBytesFormatted || "0 B"}
              </div>
              <p className="text-muted-foreground text-xs">
                {stats?.savedPercent?.toFixed(1) || 0}% through deduplication
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Rate Limit</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats?.rateLimit || 2}/sec</div>
              <p className="text-muted-foreground text-xs">API calls allowed</p>
            </CardContent>
          </Card>
        </div>

        {/* Toolbar */}
        <div className="mb-4 flex items-center gap-2">
          <Button onClick={() => setCreateFolderOpen(true)}>
            <FolderPlus className="mr-2 h-4 w-4" />
            New Folder
          </Button>
          <Button variant="outline" onClick={() => setUploadDialogOpen(true)}>
            <Upload className="mr-2 h-4 w-4" />
            Upload
          </Button>
        </div>

        {/* Files and Folders List */}
        <div className="rounded-lg border">
          <div className="grid grid-cols-[1fr_100px_120px_40px] gap-4 border-b bg-muted/50 px-4 py-3 text-sm font-medium">
            <div>Name</div>
            <div>Size</div>
            <div>Modified</div>
            <div></div>
          </div>

          {/* Folders */}
          {folders.map((folder) => (
            <div
              key={folder.id}
              className="grid grid-cols-[1fr_100px_120px_40px] gap-4 border-b px-4 py-3 hover:bg-muted/50"
            >
              <div className="flex items-center gap-3">
                <Folder className="h-5 w-5 text-blue-500" />
                <a
                  href={`/dashboard/folder/${folder.id}`}
                  className="hover:underline"
                >
                  {folder.name}
                </a>
              </div>
              <div className="text-muted-foreground text-sm">--</div>
              <div className="text-muted-foreground text-sm">
                {formatDate(folder.updatedAt)}
              </div>
              <div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8">
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={() => {
                        setRenameItem({ id: folder.id, name: folder.name, type: "folder" });
                        setRenameDialogOpen(true);
                      }}
                    >
                      <Pencil className="mr-2 h-4 w-4" />
                      Rename
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive"
                      onClick={() => {
                        setDeleteItem({ id: folder.id, name: folder.name, type: "folder" });
                        setDeleteDialogOpen(true);
                      }}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          ))}

          {/* Files */}
          {files.map((file) => (
            <div
              key={file.id}
              className="grid grid-cols-[1fr_100px_120px_40px] gap-4 border-b px-4 py-3 hover:bg-muted/50"
            >
              <div className="flex items-center gap-3">
                <File className="text-muted-foreground h-5 w-5" />
                <span>{file.name}</span>
                {file.isPublic && (
                  <Share2 className="h-4 w-4 text-green-500" />
                )}
                {file.isDeduplicated && (
                  <span title="Deduplicated">
                    <Copy className="h-4 w-4 text-orange-500" />
                  </span>
                )}
              </div>
              <div className="text-muted-foreground text-sm">
                {formatBytes(file.size)}
              </div>
              <div className="text-muted-foreground text-sm">
                {formatDate(file.uploadDate)}
              </div>
              <div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8">
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={() => {
                        setRenameItem({ id: file.id, name: file.name, type: "file" });
                        setRenameDialogOpen(true);
                      }}
                    >
                      <Pencil className="mr-2 h-4 w-4" />
                      Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => {
                        setShareItem({
                          id: file.id,
                          name: file.name,
                          isPublic: file.isPublic,
                          publicShareId: file.publicShareId,
                        });
                        setShareDialogOpen(true);
                      }}
                    >
                      <Share2 className="mr-2 h-4 w-4" />
                      Share
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive"
                      onClick={() => {
                        setDeleteItem({ id: file.id, name: file.name, type: "file" });
                        setDeleteDialogOpen(true);
                      }}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      Move to Trash
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          ))}

          {/* Empty State */}
          {folders.length === 0 && files.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Folder className="text-muted-foreground mb-4 h-12 w-12" />
              <h3 className="text-lg font-semibold">No files yet</h3>
              <p className="text-muted-foreground mb-4">
                Upload files or create a folder to get started
              </p>
              <div className="flex gap-2">
                <Button onClick={() => setCreateFolderOpen(true)}>
                  <FolderPlus className="mr-2 h-4 w-4" />
                  New Folder
                </Button>
                <Button variant="outline" onClick={() => setUploadDialogOpen(true)}>
                  <Upload className="mr-2 h-4 w-4" />
                  Upload
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Create Folder Dialog */}
      <Dialog open={createFolderOpen} onOpenChange={setCreateFolderOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create New Folder</DialogTitle>
            <DialogDescription>
              Enter a name for your new folder.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="folder-name">Folder Name</Label>
            <Input
              id="folder-name"
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder="My Folder"
              className="mt-2"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreateFolder();
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateFolderOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleCreateFolder}
              disabled={createFolderMutation.isPending}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename Dialog */}
      <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename {renameItem?.type}</DialogTitle>
            <DialogDescription>
              Enter a new name for this {renameItem?.type}.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <Label htmlFor="rename-input">Name</Label>
            <Input
              id="rename-input"
              value={renameItem?.name || ""}
              onChange={(e) =>
                setRenameItem(
                  renameItem ? { ...renameItem, name: e.target.value } : null
                )
              }
              className="mt-2"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleRename();
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleRename}
              disabled={
                renameFolderMutation.isPending || renameFileMutation.isPending
              }
            >
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteItem?.type === "folder"
                ? "Delete Folder"
                : "Move to Trash"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteItem?.type === "folder"
                ? `Are you sure you want to delete "${deleteItem?.name}"? The folder must be empty.`
                : `Are you sure you want to move "${deleteItem?.name}" to trash? You can restore it later.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteItem?.type === "folder" ? "Delete" : "Move to Trash"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Share Dialog */}
      <Dialog open={shareDialogOpen} onOpenChange={setShareDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Share "{shareItem?.name}"</DialogTitle>
            <DialogDescription>
              Control who can access this file.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <Label>Public Access</Label>
                <p className="text-muted-foreground text-sm">
                  Anyone with the link can download
                </p>
              </div>
              <Switch
                checked={shareItem?.isPublic || false}
                onCheckedChange={handleTogglePublic}
                disabled={togglePublicMutation.isPending}
              />
            </div>
            {shareItem?.isPublic && shareItem?.publicShareId && (
              <div>
                <Label>Share Link</Label>
                <div className="mt-2 flex gap-2">
                  <Input
                    readOnly
                    value={`${window.location.origin}/share/${shareItem.publicShareId}`}
                  />
                  <Button variant="outline" onClick={copyShareLink}>
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button onClick={() => setShareDialogOpen(false)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Upload Dialog */}
      <Dialog open={uploadDialogOpen} onOpenChange={setUploadDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Upload Files</DialogTitle>
            <DialogDescription>
              Upload files to your storage. Duplicate files are automatically detected.
            </DialogDescription>
          </DialogHeader>
          <FileUpload onComplete={() => setUploadDialogOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}
