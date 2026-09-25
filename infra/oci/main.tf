# Cloud site on OCI Always Free: one Ampere A1 VM with outbound-only networking. Inbound is closed except
# optional SSH from admin_cidrs; self-hosted apps are published through Cloudflare Tunnel.

data "oci_identity_availability_domains" "ads" {
  compartment_id = var.tenancy_ocid
}

resource "oci_identity_compartment" "ve" {
  compartment_id = var.tenancy_ocid
  name           = var.compartment_name
  description    = "Virtual enterprise cloud site"
  enable_delete  = true
}

# --- Guardrail: alert on any spend (Always Free should cost $0) ---------------------------------------------

resource "oci_budget_budget" "zero_spend" {
  compartment_id = var.tenancy_ocid
  display_name   = "ve-zero-spend"
  amount         = 1
  reset_period   = "MONTHLY"
  target_type    = "COMPARTMENT"
  targets        = [var.tenancy_ocid]
}

resource "oci_budget_alert_rule" "zero_spend" {
  budget_id      = oci_budget_budget.zero_spend.id
  display_name   = "any-actual-spend"
  type           = "ACTUAL"
  threshold      = 1
  threshold_type = "ABSOLUTE"
  recipients     = var.budget_alert_email
  message        = "The virtual enterprise OCI tenancy has actual spend. Always Free resources should cost nothing."
}

# --- Network ------------------------------------------------------------------------------------------------

resource "oci_core_vcn" "ve" {
  compartment_id = oci_identity_compartment.ve.id
  cidr_blocks    = ["10.40.0.0/16"]
  display_name   = "ve-vcn"
  dns_label      = "ve"
}

resource "oci_core_internet_gateway" "ve" {
  compartment_id = oci_identity_compartment.ve.id
  vcn_id         = oci_core_vcn.ve.id
  display_name   = "ve-igw"
  enabled        = true
}

resource "oci_core_route_table" "cloud" {
  compartment_id = oci_identity_compartment.ve.id
  vcn_id         = oci_core_vcn.ve.id
  display_name   = "ve-cloud-rt"

  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_internet_gateway.ve.id
  }
}

# Replaces the VCN default list (which allows SSH from anywhere) on this subnet.
resource "oci_core_security_list" "cloud" {
  compartment_id = oci_identity_compartment.ve.id
  vcn_id         = oci_core_vcn.ve.id
  display_name   = "ve-cloud-sl"

  egress_security_rules {
    destination = "0.0.0.0/0"
    protocol    = "all"
  }

  dynamic "ingress_security_rules" {
    for_each = var.admin_cidrs
    content {
      source   = ingress_security_rules.value
      protocol = "6" # TCP
      tcp_options {
        min = 22
        max = 22
      }
    }
  }
}

resource "oci_core_subnet" "cloud" {
  compartment_id             = oci_identity_compartment.ve.id
  vcn_id                     = oci_core_vcn.ve.id
  cidr_block                 = "10.40.1.0/24"
  display_name               = "ve-cloud"
  dns_label                  = "cloud"
  route_table_id             = oci_core_route_table.cloud.id
  security_list_ids          = [oci_core_security_list.cloud.id]
  prohibit_public_ip_on_vnic = false
}

# --- VM -----------------------------------------------------------------------------------------------------

data "oci_core_images" "ubuntu" {
  compartment_id           = var.tenancy_ocid
  operating_system         = "Canonical Ubuntu"
  operating_system_version = "24.04"
  shape                    = "VM.Standard.A1.Flex"
  sort_by                  = "TIMECREATED"
  sort_order               = "DESC"
}

resource "oci_core_instance" "cloud" {
  compartment_id      = oci_identity_compartment.ve.id
  availability_domain = data.oci_identity_availability_domains.ads.availability_domains[var.availability_domain_index].name
  display_name        = "ve-cloud-1"
  shape               = "VM.Standard.A1.Flex"

  shape_config {
    ocpus         = var.ocpus
    memory_in_gbs = var.memory_gb
  }

  source_details {
    source_type             = "image"
    source_id               = data.oci_core_images.ubuntu.images[0].id
    boot_volume_size_in_gbs = var.boot_volume_gb
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.cloud.id
    assign_public_ip = true
    hostname_label   = "cloud1"
  }

  metadata = {
    ssh_authorized_keys = trimspace(file(pathexpand(var.ssh_public_key_path)))
    user_data           = base64encode(file("${path.module}/cloud-init.yaml"))
  }

  # A newer image or edited cloud-init must not replace a running VM.
  lifecycle {
    ignore_changes = [source_details, metadata["user_data"]]
  }
}

# --- Optional Always Free Autonomous Database ---------------------------------------------------------------

resource "oci_database_autonomous_database" "data" {
  count                    = var.create_autonomous_db ? 1 : 0
  compartment_id           = oci_identity_compartment.ve.id
  db_name                  = "vedata"
  display_name             = "ve-data"
  db_workload              = "OLTP"
  is_free_tier             = true
  cpu_core_count           = 1
  data_storage_size_in_tbs = 1
  admin_password           = var.adb_admin_password

  lifecycle {
    precondition {
      condition     = var.adb_admin_password != null
      error_message = "Set TF_VAR_adb_admin_password when create_autonomous_db is true."
    }
  }
}
