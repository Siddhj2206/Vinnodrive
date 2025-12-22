import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Folder, FolderOpen, Home, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { StorageInvalidations } from "@/utils/invalidate";
import { useTRPC } from "@/utils/trpc";

interface MoveItem {
  id: string;
  name: string;
  type: "file" | "folder";
}

interface MoveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: MoveItem[];
  currentFolderId?: string | null;
}

interface FolderNode {
  id: string;
  name: string;
  parentId: string | null;
  children: FolderNode[];
}

export function MoveDialog({
  open,
  onOpenChange,
  items,
  currentFolderId,
}: MoveDialogProps) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  // Get all folders
  const foldersQuery = useQuery({
    ...trpc.storage.listFolders.queryOptions(),
    enabled: open,
  });

  // Move mutations
  const moveFileMutation = useMutation(
    trpc.storage.moveFile.mutationOptions({
      onSuccess: () => {
        StorageInvalidations.afterFileMove(queryClient);
      },
    })
  );

  const moveFilesMutation = useMutation(
    trpc.storage.moveFiles.mutationOptions({
      onSuccess: () => {
        StorageInvalidations.afterFileMove(queryClient);
      },
    })
  );

  const moveFolderMutation = useMutation(
    trpc.storage.moveFolder.mutationOptions({
      onSuccess: () => {
        StorageInvalidations.afterFolderChange(queryClient);
      },
    })
  );

  const moveFoldersMutation = useMutation(
    trpc.storage.moveFolders.mutationOptions({
      onSuccess: () => {
        StorageInvalidations.afterFolderChange(queryClient);
      },
    })
  );

  const isMoving =
    moveFileMutation.isPending ||
    moveFilesMutation.isPending ||
    moveFolderMutation.isPending ||
    moveFoldersMutation.isPending;

  // Build folder tree from flat list
  const buildFolderTree = (folders: typeof foldersQuery.data): FolderNode[] => {
    if (!folders) return [];

    const folderMap = new Map<string, FolderNode>();
    const rootFolders: FolderNode[] = [];

    // Create nodes
    for (const folder of folders) {
      folderMap.set(folder.id, {
        id: folder.id,
        name: folder.name,
        parentId: folder.parentId,
        children: [],
      });
    }

    // Build tree
    for (const folder of folders) {
      const node = folderMap.get(folder.id)!;
      if (folder.parentId && folderMap.has(folder.parentId)) {
        folderMap.get(folder.parentId)!.children.push(node);
      } else {
        rootFolders.push(node);
      }
    }

    // Sort children alphabetically
    const sortChildren = (nodes: FolderNode[]) => {
      nodes.sort((a, b) => a.name.localeCompare(b.name));
      for (const node of nodes) {
        sortChildren(node.children);
      }
    };
    sortChildren(rootFolders);

    return rootFolders;
  };

  const folderTree = buildFolderTree(foldersQuery.data);

  // Get IDs of folders being moved (to disable them as targets)
  const movingFolderIds = new Set(
    items.filter((item) => item.type === "folder").map((item) => item.id)
  );

  // Check if a folder is a descendant of any moving folder
  const isDescendantOfMoving = (folderId: string): boolean => {
    if (movingFolderIds.has(folderId)) return true;

    const folder = foldersQuery.data?.find((f) => f.id === folderId);
    if (!folder || !folder.parentId) return false;

    return isDescendantOfMoving(folder.parentId);
  };

  const toggleExpand = (folderId: string) => {
    const newExpanded = new Set(expandedFolders);
    if (newExpanded.has(folderId)) {
      newExpanded.delete(folderId);
    } else {
      newExpanded.add(folderId);
    }
    setExpandedFolders(newExpanded);
  };

  const handleMove = async () => {
    const files = items.filter((item) => item.type === "file");
    const folders = items.filter((item) => item.type === "folder");

    try {
      // Move files
      if (files.length === 1) {
        await moveFileMutation.mutateAsync({
          id: files[0].id,
          folderId: selectedFolderId,
        });
      } else if (files.length > 1) {
        await moveFilesMutation.mutateAsync({
          ids: files.map((f) => f.id),
          folderId: selectedFolderId,
        });
      }

      // Move folders
      if (folders.length === 1) {
        await moveFolderMutation.mutateAsync({
          id: folders[0].id,
          parentId: selectedFolderId,
        });
      } else if (folders.length > 1) {
        await moveFoldersMutation.mutateAsync({
          ids: folders.map((f) => f.id),
          parentId: selectedFolderId,
        });
      }

      const totalItems = items.length;
      toast.success(
        `Moved ${totalItems} ${totalItems === 1 ? "item" : "items"} successfully`
      );
      onOpenChange(false);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to move items"
      );
    }
  };

  const renderFolder = (folder: FolderNode, depth: number = 0) => {
    const isDisabled = isDescendantOfMoving(folder.id);
    const isSelected = selectedFolderId === folder.id;
    const isExpanded = expandedFolders.has(folder.id);
    const hasChildren = folder.children.length > 0;
    const isCurrent = folder.id === currentFolderId;

    return (
      <div key={folder.id}>
        <div
          className={`flex items-center gap-1 rounded-md px-2 py-1.5 ${
            isDisabled
              ? "cursor-not-allowed opacity-50"
              : isSelected
                ? "bg-primary text-primary-foreground"
                : "hover:bg-muted cursor-pointer"
          } ${isCurrent ? "ring-primary/50 ring-2" : ""}`}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
          onClick={() => {
            if (!isDisabled) {
              setSelectedFolderId(folder.id);
            }
          }}
        >
          {hasChildren ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                toggleExpand(folder.id);
              }}
              className="hover:bg-muted-foreground/20 rounded p-0.5"
            >
              <ChevronRight
                className={`h-4 w-4 transition-transform ${isExpanded ? "rotate-90" : ""}`}
              />
            </button>
          ) : (
            <span className="w-5" />
          )}
          {isExpanded ? (
            <FolderOpen className="h-4 w-4 shrink-0 text-blue-500" />
          ) : (
            <Folder className="h-4 w-4 shrink-0 text-blue-500" />
          )}
          <span className="truncate text-sm">{folder.name}</span>
          {isCurrent && (
            <span className="text-muted-foreground ml-auto text-xs">
              (current)
            </span>
          )}
        </div>
        {isExpanded &&
          folder.children.map((child) => renderFolder(child, depth + 1))}
      </div>
    );
  };

  const itemNames =
    items.length === 1
      ? `"${items[0].name}"`
      : `${items.length} items`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Move {itemNames}</DialogTitle>
          <DialogDescription>
            Select a destination folder. Click a folder to select it.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="h-[300px] rounded-md border">
          <div className="p-2">
            {/* Root option */}
            <div
              className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 ${
                selectedFolderId === null
                  ? "bg-primary text-primary-foreground"
                  : "hover:bg-muted"
              } ${currentFolderId === null ? "ring-primary/50 ring-2" : ""}`}
              onClick={() => setSelectedFolderId(null)}
            >
              <Home className="h-4 w-4" />
              <span className="text-sm font-medium">All Files (Root)</span>
              {currentFolderId === null && (
                <span className="text-muted-foreground ml-auto text-xs">
                  (current)
                </span>
              )}
            </div>

            {/* Folder tree */}
            {foldersQuery.isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin" />
              </div>
            ) : folderTree.length > 0 ? (
              <div className="mt-1">
                {folderTree.map((folder) => renderFolder(folder))}
              </div>
            ) : null}
          </div>
        </ScrollArea>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleMove}
            disabled={isMoving || selectedFolderId === currentFolderId}
          >
            {isMoving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Moving...
              </>
            ) : (
              "Move Here"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
