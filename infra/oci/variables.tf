# API key authentication (OCI console: Profile -> My profile -> API keys).
variable "tenancy_ocid" {
  type        = string
  description = "Tenancy OCID."
}

variable "user_ocid" {
  type        = string
  description = "OCID of the user that owns the API key."
}

variable "fingerprint" {
  type        = string
  description = "Fingerprint of the API signing key."
}

variable "private_key_path" {
  type        = string
  description = "Path to the API signing private key (outside the repo)."
}

variable "region" {
  type        = string
  description = "Home region identifier, e.g. us-ashburn-1. Always Free A1 capacity exists only in the home region."
}

variable "compartment_name" {
  type        = string
  default     = "virtual-enterprise"
  description = "Compartment that holds every resource of the cloud site."
}

variable "ssh_public_key_path" {
  type        = string
  description = "Public half of the cloud site SSH key (outside the repo)."
}

variable "admin_cidrs" {
  type        = list(string)
  default     = []
  description = "Source CIDRs allowed to SSH (port 22), e.g. [\"203.0.113.7/32\"]. Empty = no inbound at all."
}

variable "availability_domain_index" {
  type        = number
  default     = 0
  description = "Which availability domain to place the VM in. Change it if A1 reports 'Out of host capacity'."
}

variable "ocpus" {
  type        = number
  default     = 4
  description = "A1 OCPUs (Always Free total: 4)."
}

variable "memory_gb" {
  type        = number
  default     = 24
  description = "A1 memory in GB (Always Free total: 24)."
}

variable "boot_volume_gb" {
  type        = number
  default     = 100
  description = "Boot volume size (Always Free block storage total: 200 GB)."
}

variable "budget_alert_email" {
  type        = string
  description = "Recipient of the zero-spend budget alert (the operator mailbox)."
}

variable "create_autonomous_db" {
  type        = bool
  default     = false
  description = "Create the Always Free Autonomous Database (extra data source). Enable when data loads need it."
}

variable "adb_admin_password" {
  type        = string
  default     = null
  sensitive   = true
  description = "ADMIN password for the Autonomous Database. Pass via TF_VAR_adb_admin_password, never in a file."
}
