output "vms" {
  description = "Name, zone and addresses of every VM."
  value = {
    for key, vm in azurerm_linux_virtual_machine.vm : key => {
      name       = vm.name
      zone       = vm.zone
      size       = vm.size
      public_ip  = azurerm_public_ip.ip[key].ip_address
      private_ip = azurerm_network_interface.nic[key].private_ip_address
    }
  }
}

output "storage_account" {
  value = azurerm_storage_account.cold.name
}

output "storage_container" {
  value = azurerm_storage_container.depot.name
}

output "admin_username" {
  value = var.admin_username
}

output "bench_private_key" {
  description = "Key installed on every VM, handed to the runner so it can reset storage workers."
  value       = tls_private_key.bench.private_key_openssh
  sensitive   = true
}
