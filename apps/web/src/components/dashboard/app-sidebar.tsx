import { Link, useLocation } from "@tanstack/react-router";
import {
  ChevronRight,
  Files,
  Folder,
  HardDrive,
  Home,
  Share2,
  Trash2,
  Upload,
} from "lucide-react";
import { useState } from "react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
} from "@/components/ui/sidebar";

import { FileUpload } from "./file-upload";
import { NavUser } from "./nav-user";
import { StorageCard } from "./storage-card";

interface Folder {
  id: string;
  name: string;
  children?: Folder[];
}

interface AppSidebarProps {
  folders?: Folder[];
  user: {
    name: string;
    email: string;
    avatar?: string;
  };
  storageUsed: number;
  storageLimit: number;
}

export function AppSidebar({
  folders = [],
  user,
  storageUsed,
  storageLimit,
}: AppSidebarProps) {
  const location = useLocation();
  const pathname = location.pathname;
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);

  return (
    <>
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" asChild>
                <Link to="/dashboard">
                  <div className="bg-primary text-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg">
                    <HardDrive className="size-4" />
                  </div>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-semibold">VinnoDrive</span>
                  </div>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>

        <SidebarContent>
          {/* Main Navigation */}
          <SidebarGroup>
            <SidebarGroupLabel>Files</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {/* Home - root files */}
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    tooltip="Home"
                    isActive={pathname === "/dashboard"}
                  >
                    <Link to="/dashboard">
                      <Home />
                      <span>Home</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>

                {/* All Files - collapsible folder list */}
                <Collapsible asChild defaultOpen className="group/collapsible">
                  <SidebarMenuItem>
                    <CollapsibleTrigger asChild>
                      <SidebarMenuButton
                        tooltip="Folders"
                        isActive={pathname.startsWith("/dashboard/folder")}
                      >
                        <Files />
                        <span>Folders</span>
                        {folders.length > 0 && (
                          <ChevronRight className="ml-auto size-4 transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
                        )}
                      </SidebarMenuButton>
                    </CollapsibleTrigger>
                    {folders.length > 0 && (
                      <CollapsibleContent>
                        <SidebarMenuSub>
                          {folders.map((folder) => (
                            <SidebarMenuSubItem key={folder.id}>
                              <SidebarMenuSubButton
                                asChild
                                isActive={
                                  pathname === `/dashboard/folder/${folder.id}`
                                }
                              >
                                <Link
                                  to="/dashboard/folder/$folderId"
                                  params={{ folderId: folder.id }}
                                >
                                  <Folder className="size-4" />
                                  <span>{folder.name}</span>
                                </Link>
                              </SidebarMenuSubButton>
                            </SidebarMenuSubItem>
                          ))}
                        </SidebarMenuSub>
                      </CollapsibleContent>
                    )}
                  </SidebarMenuItem>
                </Collapsible>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>

          {/* Secondary Navigation */}
          <SidebarGroup>
            <SidebarGroupLabel>Quick Access</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    tooltip="Shared"
                    isActive={pathname === "/dashboard/shared"}
                  >
                    <Link to="/dashboard/shared">
                      <Share2 />
                      <span>Shared</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton
                    asChild
                    tooltip="Trash"
                    isActive={pathname === "/dashboard/trash"}
                  >
                    <Link to="/dashboard/trash">
                      <Trash2 />
                      <span>Trash</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter>
          {/* Upload Button */}
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip="Upload Files"
                onClick={() => setUploadDialogOpen(true)}
                className="bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground"
              >
                <Upload />
                <span>Upload Files</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>

          {/* Storage Card */}
          <StorageCard used={storageUsed} limit={storageLimit} />

          {/* User Menu */}
          <NavUser user={user} />
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      {/* Upload Dialog */}
      <Dialog open={uploadDialogOpen} onOpenChange={setUploadDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Upload Files</DialogTitle>
            <DialogDescription>
              Upload files to your storage. Duplicate files are automatically
              detected.
            </DialogDescription>
          </DialogHeader>
          <FileUpload onComplete={() => setUploadDialogOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}
