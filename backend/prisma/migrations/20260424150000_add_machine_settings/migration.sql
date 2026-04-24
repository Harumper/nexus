-- Add sshUser field to Machine for default SSH username per machine
ALTER TABLE "Machine" ADD COLUMN "sshUser" TEXT;
