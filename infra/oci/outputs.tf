output "compartment_id" {
  value = oci_identity_compartment.ve.id
}

output "instance_id" {
  value = oci_core_instance.cloud.id
}

output "instance_public_ip" {
  value = oci_core_instance.cloud.public_ip
}

output "availability_domain" {
  value = oci_core_instance.cloud.availability_domain
}

output "ssh_command" {
  value = "ssh -i <private key> ubuntu@${oci_core_instance.cloud.public_ip}"
}

output "autonomous_db_id" {
  value = try(oci_database_autonomous_database.data[0].id, null)
}
