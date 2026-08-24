CREATE TABLE "quote_template_policy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"full_pos_template_id" text DEFAULT '817263673055' NOT NULL,
	"food_truck_template_id" text DEFAULT '817263673055' NOT NULL,
	"marketing_only_template_id" text DEFAULT '817697352408' NOT NULL,
	"updated_by_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "quote_template_policy" ADD CONSTRAINT "quote_template_policy_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;