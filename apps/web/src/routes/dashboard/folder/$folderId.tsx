import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Copy,
  Eye,
  Folder,
  FolderPlus,
  FolderInput,
  MoreHorizontal,
  Pencil,
  Share2,
  Trash2,
  Upload,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { FileUpload } from "@/components/dashboard/file-upload";
import { FileThumbnail } from "@/components/dashboard/file-thumbnail";
import { DashboardHeader } from "@/components/dashboard/header";
import { MoveDialog } from "@/components/dashboard/move-dialog";
import { FilePreviewModal } from "@/components/dashboard/file-preview-modal";
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
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
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
import { Switch } from "@/components/ui/switch";
import { useTRPC } from "@/utils/trpc";

export const Route = createFileRoute("/dashboard/folder/$folderId")({
  component: FolderView,
  loader: async ({ context, params }) => {
    // Prefetch folder contents before rendering - uses cache if available
    await context.queryClient.ensureQueryData(
      context.trpc.storage.listFiles.queryOptions({ folderId: params.folderId })
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

function FolderView() {
  const { folderId } = Route.useParams();
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
  const [searchQuery, setSearchQuery] = useState("");
  const [moveDialogOpen, setMoveDialogOpen] = useState(false);
  const [moveItems, setMoveItems] = useState<{ id: string; name: string; type: "file" | "folder" }[]>([]);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewFile, setPreviewFile] = useState<{
    id: string;
    name: string;
    size: number;
    contentType: string | null;
  } | null>(null);

  // Queries - use cached data from loader
  const filesQuery = useQuery(
    trpc.storage.listFiles.queryOptions({ folderId })
  );

  // Mutations (same as index)
  const createFolderMutation = useMutation(
    trpc.storage.createFolder.mutationOptions({
      onSuccess: () => {
        StorageInvalidations.afterFolderChange(queryClient);
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
        StorageInvalidations.afterFolderChange(queryClient);
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
        StorageInvalidations.afterFileRename(queryClient);
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
    trpc.storage.moveFolderToTrash.mutationOptions({
      onSuccess: () => {
        StorageInvalidations.afterMoveToTrash(queryClient);
        setDeleteDialogOpen(false);
        setDeleteItem(null);
        toast.success("Folder moved to trash");
      },
      onError: (error) => {
        toast.error(error.message);
      },
    })
  );

  const moveToTrashMutation = useMutation(
    trpc.storage.moveToTrash.mutationOptions({
      onSuccess: () => {
        StorageInvalidations.afterMoveToTrash(queryClient);
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
        StorageInvalidations.afterToggleShare(queryClient);
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
    createFolderMutation.mutate({
      name: newFolderName.trim(),
      parentId: folderId,
    });
  };

  const handleRename = () => {
    if (!renameItem || !renameItem.name.trim()) return;
    if (renameItem.type === "folder") {
      renameFolderMutation.mutate({
        id: renameItem.id,
        name: renameItem.name.trim(),
      });
    } else {
      renameFileMutation.mutate({
        id: renameItem.id,
        name: renameItem.name.trim(),
      });
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

  const allFiles = filesQuery.data?.files || [];
  const allFolders = filesQuery.data?.folders || [];

  // Filter files and folders based on search query
  const searchLower = searchQuery.toLowerCase();
  const files = searchQuery
    ? allFiles.filter((file) => file.name.toLowerCase().includes(searchLower))
    : allFiles;
  const folders = searchQuery
    ? allFolders.filter((folder) => folder.name.toLowerCase().includes(searchLower))
    : allFolders;

  return (
    <>
      <DashboardHeader
        breadcrumbs={[
          { label: "All Files", href: "/dashboard" },
          { label: "Folder" },
        ]}
        searchPlaceholder="Search files..."
        searchValue={searchQuery}
        onSearchChange={setSearchQuery}
      />

      {/* Main Content */}
      <div className="flex-1 overflow-auto p-4">
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
                <Link
                  to="/dashboard/folder/$folderId"
                  params={{ folderId: folder.id }}
                  className="hover:underline"
                >
                  {folder.name}
                </Link>
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
                        setRenameItem({
                          id: folder.id,
                          name: folder.name,
                          type: "folder",
                        });
                        setRenameDialogOpen(true);
                      }}
                    >
                      <Pencil className="mr-2 h-4 w-4" />
                      Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => {
                        setMoveItems([{ id: folder.id, name: folder.name, type: "folder" }]);
                        setMoveDialogOpen(true);
                      }}
                    >
                      <FolderInput className="mr-2 h-4 w-4" />
                      Move to...
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive"
                      onClick={() => {
                        setDeleteItem({
                          id: folder.id,
                          name: folder.name,
                          type: "folder",
                        });
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

          {/* Files */}
          {files.map((file) => (
            <div
              key={file.id}
              className="grid grid-cols-[1fr_100px_120px_40px] gap-4 border-b px-4 py-3 hover:bg-muted/50"
            >
              <div className="flex items-center gap-3">
                <FileThumbnail
                  fileId={file.id}
                  fileName={file.name}
                  contentType={file.contentType}
                  className="h-8 w-8 flex-shrink-0"
                />
                <button
                  className="hover:underline text-left truncate"
                  onClick={() => {
                    setPreviewFile({
                      id: file.id,
                      name: file.name,
                      size: file.size,
                      contentType: file.contentType,
                    });
                    setPreviewOpen(true);
                  }}
                >
                  {file.name}
                </button>
                {file.isPublic && (
                  <Share2 className="h-4 w-4 text-green-500 flex-shrink-0" />
                )}
                {file.isDeduplicated && (
                  <span title="Deduplicated">
                    <Copy className="h-4 w-4 text-orange-500 flex-shrink-0" />
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
                        setPreviewFile({
                          id: file.id,
                          name: file.name,
                          size: file.size,
                          contentType: file.contentType,
                        });
                        setPreviewOpen(true);
                      }}
                    >
                      <Eye className="mr-2 h-4 w-4" />
                      Preview
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => {
                        setRenameItem({
                          id: file.id,
                          name: file.name,
                          type: "file",
                        });
                        setRenameDialogOpen(true);
                      }}
                    >
                      <Pencil className="mr-2 h-4 w-4" />
                      Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => {
                        setMoveItems([{ id: file.id, name: file.name, type: "file" }]);
                        setMoveDialogOpen(true);
                      }}
                    >
                      <FolderInput className="mr-2 h-4 w-4" />
                      Move to...
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
                        setDeleteItem({
                          id: file.id,
                          name: file.name,
                          type: "file",
                        });
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
              {searchQuery ? (
                <>
                  <h3 className="text-lg font-semibold">No results found</h3>
                  <p className="text-muted-foreground">
                    No files or folders match "{searchQuery}"
                  </p>
                </>
              ) : (
                <>
                  <h3 className="text-lg font-semibold">This folder is empty</h3>
                  <p className="text-muted-foreground mb-4">
                    Upload files or create a subfolder
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
                </>
              )}
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
            <Button
              variant="outline"
              onClick={() => setCreateFolderOpen(false)}
            >
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
            <Button
              variant="outline"
              onClick={() => setRenameDialogOpen(false)}
            >
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
            <AlertDialogTitle>Move to Trash</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to move "{deleteItem?.name}" to trash?{" "}
              {deleteItem?.type === "folder"
                ? "The folder and all its contents will be moved to trash."
                : "You can restore it later."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Move to Trash
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
          <div className="space-y-4 py-4">
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
              Upload files to this folder. Duplicate files are automatically detected.
            </DialogDescription>
          </DialogHeader>
          <FileUpload folderId={folderId} onComplete={() => setUploadDialogOpen(false)} />
        </DialogContent>
      </Dialog>

      {/* Move Dialog */}
      <MoveDialog
        open={moveDialogOpen}
        onOpenChange={setMoveDialogOpen}
        items={moveItems}
        currentFolderId={folderId}
      />

      {/* Preview Modal */}
      <FilePreviewModal
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        file={previewFile}
      />
    </>
  );
}
