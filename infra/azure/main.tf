# Rivet benchmark cluster: three storage workers with local NVMe in three availability zones,
# one runner VM that also hosts the load driver (and the Cloudflare client), one Blob storage
# account as the cold store. Everything is created inside an existing resource group and
# prefixed with var.prefix so it can be destroyed as a unit.

data "azurerm_resource_group" "rg" {
  name = var.resource_group
}

resource "random_string" "suffix" {
  length  = 8
  lower   = true
  upper   = false
  numeric = true
  special = false
}

# Key the runner uses to reach the storage workers (memory readings in the hold scenario).
resource "tls_private_key" "bench" {
  algorithm = "ED25519"
}

resource "azurerm_virtual_network" "vnet" {
  name                = "${var.prefix}-vnet"
  location            = data.azurerm_resource_group.rg.location
  resource_group_name = data.azurerm_resource_group.rg.name
  address_space       = [var.vnet_cidr]
}

resource "azurerm_subnet" "subnet" {
  name                 = "${var.prefix}-subnet"
  resource_group_name  = data.azurerm_resource_group.rg.name
  virtual_network_name = azurerm_virtual_network.vnet.name
  address_prefixes     = [cidrsubnet(var.vnet_cidr, 8, 1)]
}

resource "azurerm_network_security_group" "nsg" {
  name                = "${var.prefix}-nsg"
  location            = data.azurerm_resource_group.rg.location
  resource_group_name = data.azurerm_resource_group.rg.name

  security_rule {
    name                       = "ssh"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "22"
    source_address_prefixes    = var.ssh_source_cidrs
    destination_address_prefix = "*"
  }
  # Engine ports stay inside the VNet (the default rules allow VNet traffic); nothing else
  # is reachable from the internet.
}

resource "azurerm_subnet_network_security_group_association" "nsg" {
  subnet_id                 = azurerm_subnet.subnet.id
  network_security_group_id = azurerm_network_security_group.nsg.id
}

locals {
  vms = merge(
    { for zone in var.storage_zones : "storage-z${zone}" => { zone = zone, size = var.storage_vm_size, os_disk_gb = 64 } },
    { "runner" = { zone = var.runner_zone, size = var.runner_vm_size, os_disk_gb = 128 } },
  )
}

resource "azurerm_public_ip" "ip" {
  for_each            = local.vms
  name                = "${var.prefix}-${each.key}-ip"
  location            = data.azurerm_resource_group.rg.location
  resource_group_name = data.azurerm_resource_group.rg.name
  allocation_method   = "Static"
  sku                 = "Standard"
  zones               = [each.value.zone]
}

resource "azurerm_network_interface" "nic" {
  for_each                       = local.vms
  name                           = "${var.prefix}-${each.key}-nic"
  location                       = data.azurerm_resource_group.rg.location
  resource_group_name            = data.azurerm_resource_group.rg.name
  accelerated_networking_enabled = true

  ip_configuration {
    name                          = "primary"
    subnet_id                     = azurerm_subnet.subnet.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.ip[each.key].id
  }
}

resource "azurerm_linux_virtual_machine" "vm" {
  for_each              = local.vms
  name                  = "${var.prefix}-${each.key}"
  location              = data.azurerm_resource_group.rg.location
  resource_group_name   = data.azurerm_resource_group.rg.name
  size                  = each.value.size
  zone                  = each.value.zone
  admin_username        = var.admin_username
  network_interface_ids = [azurerm_network_interface.nic[each.key].id]

  admin_ssh_key {
    username   = var.admin_username
    public_key = file(var.ssh_public_key_file)
  }
  admin_ssh_key {
    username   = var.admin_username
    public_key = tls_private_key.bench.public_key_openssh
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Premium_LRS"
    disk_size_gb         = each.value.os_disk_gb
  }

  source_image_reference {
    publisher = var.image.publisher
    offer     = var.image.offer
    sku       = var.image.sku
    version   = var.image.version
  }

  tags = { bench = var.prefix }
}

# Cold store: Azure Blob, Standard LRS, Hot tier.
resource "azurerm_storage_account" "cold" {
  name                     = "${replace(var.prefix, "-", "")}${random_string.suffix.result}"
  location                 = data.azurerm_resource_group.rg.location
  resource_group_name      = data.azurerm_resource_group.rg.name
  account_tier             = "Standard"
  account_replication_type = "LRS"
  account_kind             = "StorageV2"
  access_tier              = "Hot"
  tags                     = { bench = var.prefix }
}

resource "azurerm_storage_container" "depot" {
  name                  = "depot"
  storage_account_id    = azurerm_storage_account.cold.id
  container_access_type = "private"
}
