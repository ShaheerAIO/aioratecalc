ALTER TABLE "users" ADD COLUMN "entra_oid" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "entra_linked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_entra_oid_unique" UNIQUE("entra_oid");