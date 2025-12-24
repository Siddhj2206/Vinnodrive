import { Cloud } from "lucide-react";

import { Progress } from "@/components/ui/progress";
import { useSidebar } from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatBytes } from "@/lib/utils";

interface StorageCardProps {
  used: number;
  limit: number;
}

export function StorageCard({ used, limit }: StorageCardProps) {
  const { state } = useSidebar();
  const isCollapsed = state === "collapsed";
  const percentage = Math.min((used / limit) * 100, 100);
  const isNearLimit = percentage >= 80;
  const isOverLimit = percentage >= 95;

  // Collapsed view - just show an icon with tooltip
  if (isCollapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex justify-center p-2">
            <div className="relative">
              <Cloud
                className={`h-5 w-5 ${
                  isOverLimit
                    ? "text-destructive"
                    : isNearLimit
                      ? "text-yellow-500"
                      : "text-muted-foreground"
                }`}
              />
              {/* Small indicator dot */}
              <div
                className={`absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full ${
                  isOverLimit
                    ? "bg-destructive"
                    : isNearLimit
                      ? "bg-yellow-500"
                      : "bg-primary"
                }`}
                style={{
                  background: `conic-gradient(currentColor ${percentage}%, transparent ${percentage}%)`,
                }}
              />
            </div>
          </div>
        </TooltipTrigger>
        <TooltipContent side="right">
          <p className="font-medium">Storage</p>
          <p className="text-xs">
            {formatBytes(used)} of {formatBytes(limit)} used
          </p>
          <p className="text-xs">{percentage.toFixed(0)}% used</p>
        </TooltipContent>
      </Tooltip>
    );
  }

  // Expanded view - full card
  return (
    <div className="bg-sidebar-accent/50 rounded-lg p-3">
      <div className="mb-2 flex items-center gap-2">
        <Cloud className="text-muted-foreground h-4 w-4" />
        <span className="text-sm font-medium">Storage</span>
      </div>
      <Progress
        value={percentage}
        className={`h-2 ${isOverLimit ? "[&>div]:bg-destructive" : isNearLimit ? "[&>div]:bg-yellow-500" : ""}`}
      />
      <div className="text-muted-foreground mt-2 text-xs">
        {formatBytes(used)} of {formatBytes(limit)} used
      </div>
      {isNearLimit && !isOverLimit && (
        <div className="mt-1 text-xs text-yellow-600 dark:text-yellow-500">
          Running low on storage
        </div>
      )}
      {isOverLimit && (
        <div className="text-destructive mt-1 text-xs">
          Storage almost full
        </div>
      )}
    </div>
  );
}
