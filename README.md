# VinnoDrive

A modern, self-hosted cloud storage platform with smart file deduplication, secure sharing, and real-time storage accounting. Built with the Better-T-Stack.

## Features

- **File Storage & Management** - Upload, organize, and manage files in a folder hierarchy
- **Smart Deduplication** - Files are stored once and referenced multiple times, saving storage space
- **File Preview** - In-app preview for images, videos, audio, PDFs, and text files
- **Secure Sharing** - Generate public share links with download tracking
- **Trash & Recovery** - Soft delete with restore capability
- **Storage Quotas** - Per-user storage limits with real-time usage tracking
- **Rate Limiting** - Built-in API rate limiting per user
- **Profile Avatars** - Upload and manage user profile photos

## Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | [Bun](https://bun.sh) |
| Frontend | React 19, [TanStack Router](https://tanstack.com/router), [TanStack Query](https://tanstack.com/query) |
| Styling | TailwindCSS, [shadcn/ui](https://ui.shadcn.com) |
| Backend | [Hono](https://hono.dev) |
| API | [tRPC](https://trpc.io) (end-to-end type safety) |
| Database | PostgreSQL, [Drizzle ORM](https://orm.drizzle.team) |
| Auth | [Better Auth](https://better-auth.com) |
| Storage | Cloudflare R2 (S3-compatible) |
| Monorepo | [Turborepo](https://turbo.build) |

## Project Structure

```
Vinnodrive/
├── apps/
│   ├── web/             # Frontend (React + TanStack Router)
│   │   ├── src/
│   │   │   ├── components/   # UI components
│   │   │   ├── routes/       # File-based routing
│   │   │   ├── hooks/        # Custom React hooks
│   │   │   └── utils/        # Utilities (tRPC client, etc.)
│   │   └── ...
│   └── server/          # Backend API (Hono + tRPC)
│       └── src/
│           └── index.ts
├── packages/
│   ├── api/             # tRPC routers & business logic
│   │   └── src/routers/
│   │       ├── storage/     # File/folder operations
│   │       └── todo.ts      # Example CRUD
│   ├── auth/            # Authentication configuration
│   ├── db/              # Database schema & migrations
│   │   └── src/
│   │       ├── schema/      # Drizzle table definitions
│   │       └── migrations/  # SQL migrations
│   └── config/          # Shared TypeScript config
```

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) v1.3.5+
- PostgreSQL database
- Cloudflare R2 bucket (or any S3-compatible storage)

### Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd Vinnodrive
   ```

2. **Install dependencies**
   ```bash
   bun install
   ```

3. **Configure environment variables**

   Copy the example files and fill in your values:
   ```bash
   cp apps/server/.env.example apps/server/.env
   cp apps/web/.env.example apps/web/.env
   ```

   **Server environment (`apps/server/.env`):**
   ```env
   # Authentication
   BETTER_AUTH_SECRET=your-secret-key-min-32-chars
   BETTER_AUTH_URL=http://localhost:3000

   # CORS
   CORS_ORIGIN=http://localhost:3001

   # Database
   DATABASE_URL=postgresql://user:password@localhost:5432/vinnodrive

   # Cloudflare R2 Storage
   R2_ACCESS_KEY_ID=your-r2-access-key
   R2_SECRET_ACCESS_KEY=your-r2-secret-key
   R2_BUCKET_NAME=vinnodrive
   R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com

   # Optional: Override defaults
   # STORAGE_LIMIT_BYTES=10737418240  # 10GB default per user
   # RATE_LIMIT_PER_SECOND=2
   ```

   **Web environment (`apps/web/.env`):**
   ```env
   VITE_SERVER_URL=http://localhost:3000
   ```

4. **Set up the database**

   Push the schema to your database:
   ```bash
   bun run db:push
   ```

   Or run migrations for production:
   ```bash
   bun run db:migrate
   ```

5. **Start the development server**
   ```bash
   bun run dev
   ```

   - Web app: http://localhost:3001
   - API server: http://localhost:3000

## Available Scripts

| Command | Description |
|---------|-------------|
| `bun run dev` | Start all apps in development mode |
| `bun run build` | Build all apps for production |
| `bun run dev:web` | Start only the web frontend |
| `bun run dev:server` | Start only the API server |
| `bun run check-types` | TypeScript type checking |
| `bun run db:push` | Push schema changes to database |
| `bun run db:generate` | Generate migration files |
| `bun run db:migrate` | Run pending migrations |
| `bun run db:studio` | Open Drizzle Studio (database GUI) |

## Database Schema

### Core Tables

- **`files`** - Deduplicated file storage (keyed by SHA-256 hash)
- **`user_assets`** - User's files with metadata, folder assignment, sharing settings
- **`folders`** - Hierarchical folder structure per user
- **`user_quotas`** - Storage limits and usage per user
- **`rate_limit_windows`** - API rate limiting tracking

### Deduplication Strategy

Files are stored once in R2, identified by their SHA-256 content hash. When multiple users upload the same file:
1. The hash is computed client-side
2. Server checks if hash exists in `files` table
3. If exists, increment `refCount` and link to user
4. If not, upload to R2 and create new `files` record

This means 100 users uploading the same 1GB file only uses 1GB of storage.

## API Routes

All API routes are defined in `packages/api/src/routers/`. Key storage operations:

| Procedure | Description |
|-----------|-------------|
| `storage.getUploadPresignedUrl` | Get presigned URL for direct upload to R2 |
| `storage.confirmUpload` | Confirm upload and create asset record |
| `storage.listFiles` | List files in a folder |
| `storage.getFile` | Get file details with download URL |
| `storage.deleteFile` | Soft delete (move to trash) |
| `storage.restoreFile` | Restore from trash |
| `storage.permanentlyDeleteFile` | Permanent deletion |
| `storage.createFolder` | Create new folder |
| `storage.moveFile` | Move file to different folder |
| `storage.createShareLink` | Generate public share link |
| `storage.getPublicFile` | Access shared file (no auth required) |

## Cloudflare R2 Setup

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com) > R2
2. Create a new bucket (e.g., `vinnodrive`)
3. Go to **Manage R2 API Tokens** > Create API Token
4. Give it **Object Read & Write** permissions for your bucket
5. Copy the Access Key ID and Secret Access Key
6. Your endpoint is: `https://<account-id>.r2.cloudflarestorage.com`

**Note:** The bucket should NOT be public. All access is via presigned URLs generated by the server.

## Production Deployment

1. **Build the applications**
   ```bash
   bun run build
   ```

2. **Set production environment variables**
   - Use strong `BETTER_AUTH_SECRET` (32+ random characters)
   - Set correct `BETTER_AUTH_URL` and `CORS_ORIGIN` for your domain
   - Use production database URL

3. **Run migrations**
   ```bash
   bun run db:migrate
   ```

4. **Start the server**
   ```bash
   cd apps/server && bun run start
   ```

   For the web app, serve the built static files from `apps/web/dist/`.

## Development Tips

### Type Checking
```bash
# Check all packages
bun run check-types

# Check specific package
cd apps/web && bunx tsc --noEmit
cd packages/api && bunx tsc --noEmit
```

### Database Studio
```bash
bun run db:studio
```
Opens a web UI at http://localhost:4983 to browse and edit your database.

### Adding New API Routes

1. Create or modify routers in `packages/api/src/routers/`
2. Export from `packages/api/src/routers/index.ts`
3. Use in frontend via `trpc.routerName.procedureName.useQuery()` or `.useMutation()`

## License

MIT

---

Built with [Better-T-Stack](https://github.com/AmanVarshney01/create-better-t-stack)
